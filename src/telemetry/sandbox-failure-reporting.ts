import { statfsSync } from "node:fs";
import { totalmem } from "node:os";
import { telemetry } from "./index";

/** The error type for a Claude Code or Codex turn that failed or died. */
export const EXTERNAL_WORKER_TURN_FAILED = "external_worker_turn_failed";
/** The error type for a tool or command that ran out of disk space. */
export const SANDBOX_DISK_FULL = "sandbox_disk_full";

const DISK_FULL_PATTERN = /\bENOSPC\b|no space left on device/i;
const DISK_FULL_USED_PERCENT = 95;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const lastReportedAt = new Map<string, number>();

/** Allow one report per error type, conversation, and reason per window. */
export function shouldReportFailure(key: string, now = Date.now()): boolean {
  const last = lastReportedAt.get(key);
  if (last !== undefined && now - last < RATE_LIMIT_WINDOW_MS) return false;
  if (lastReportedAt.size > 1000) lastReportedAt.clear();
  lastReportedAt.set(key, now);
  return true;
}

export function resetFailureRateLimitForTest(): void {
  lastReportedAt.clear();
}

function safeId(id: string | null | undefined): string | undefined {
  return id && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

export interface MachineSize {
  memory_gb?: number;
  disk_total_gb?: number;
  disk_used_percent?: number;
}

/** Memory and root-disk size, so reports can be grouped by machine size. */
export function readMachineSize(path = "/"): MachineSize {
  const size: MachineSize = { memory_gb: Math.round(totalmem() / 2 ** 30) };
  try {
    const stats = statfsSync(path);
    const total = stats.blocks * stats.bsize;
    if (total > 0) {
      size.disk_total_gb = Math.round(total / 2 ** 30);
      size.disk_used_percent = Math.round(
        ((stats.blocks - stats.bavail) / stats.blocks) * 100,
      );
    }
  } catch {
    // statfs is unavailable on some platforms; report without disk size.
  }
  return size;
}

export type ExternalWorkerTurnFailureReason =
  | "disk_full"
  | "out_of_memory"
  | "broken_pipe"
  | "stdout_closed"
  | "exited"
  | "timeout"
  | "unknown";

/** Map a worker error message to a coarse reason; the message is not sent. */
export function classifyWorkerFailure(
  message: string,
): ExternalWorkerTurnFailureReason {
  if (DISK_FULL_PATTERN.test(message)) return "disk_full";
  if (/out of memory|\bOOM\b|oom-kill/i.test(message)) return "out_of_memory";
  if (/broken pipe|\bEPIPE\b/i.test(message)) return "broken_pipe";
  if (/stdout closed|lost stdout/i.test(message)) return "stdout_closed";
  if (/timed? ?out/i.test(message)) return "timeout";
  if (/exited|exit code|SIGKILL|SIGTERM/i.test(message)) return "exited";
  return "unknown";
}

function isAbortMessage(message: string): boolean {
  return /\babort(ed)?\b|interrupted by user|cancelled/i.test(message);
}

/**
 * Report a Claude Code or Codex turn that ended in failure after launch.
 * Only the reason, worker type, machine size, and opaque IDs are sent.
 */
export function reportExternalWorkerTurnFailure(options: {
  harness: string;
  error: string;
  agentId?: string;
  conversationId?: string;
  taskId?: string;
}): void {
  try {
    if (isAbortMessage(options.error)) return;
    const reason = classifyWorkerFailure(options.error);
    const conversationId = safeId(options.conversationId);
    const key = `${EXTERNAL_WORKER_TURN_FAILED}:${conversationId ?? "none"}:${reason}`;
    if (!shouldReportFailure(key)) return;
    telemetry.trackError(
      EXTERNAL_WORKER_TURN_FAILED,
      "External worker turn failed",
      JSON.stringify({
        reason,
        harness: /^[a-z-]{1,32}$/.test(options.harness)
          ? options.harness
          : undefined,
        worker_kind: workerKind(),
        agent_id: safeId(options.agentId),
        conversation_id: conversationId,
        task_id: safeId(options.taskId),
        ...readMachineSize(),
      }),
      { omitDebugLogTail: true },
    );
    void telemetry.flush().catch(() => {});
  } catch {
    // A diagnostic must never mask the worker failure itself.
  }
}

function workerKind(): "agent" | "subagent" {
  return process.env.LETTA_PARENT_AGENT_ID ? "subagent" : "agent";
}

/**
 * Report a tool or command that hit ENOSPC. Output that only mentions the
 * error counts when the disk really is nearly full, so quoting the error
 * text (for example while reading a log) does not produce a report.
 */
export function reportDiskFullIfDetected(options: {
  toolName: string;
  errorCode?: string;
  output?: string;
  agentId?: string | null;
  conversationId?: string | null;
  cwd?: string;
  readSize?: (path?: string) => MachineSize;
}): void {
  try {
    const coded = options.errorCode === "ENOSPC";
    if (!coded && !DISK_FULL_PATTERN.test(options.output ?? "")) return;
    const size = (options.readSize ?? readMachineSize)(options.cwd);
    if (!coded && (size.disk_used_percent ?? 0) < DISK_FULL_USED_PERCENT) {
      return;
    }
    const conversationId = safeId(options.conversationId);
    if (
      !shouldReportFailure(`${SANDBOX_DISK_FULL}:${conversationId ?? "none"}`)
    )
      return;
    telemetry.trackError(
      SANDBOX_DISK_FULL,
      "Sandbox disk full",
      JSON.stringify({
        tool_name: /^[a-zA-Z0-9_.-]{1,64}$/.test(options.toolName)
          ? options.toolName
          : undefined,
        worker_kind: workerKind(),
        agent_id: safeId(options.agentId),
        conversation_id: conversationId,
        ...size,
      }),
      { omitDebugLogTail: true },
    );
    void telemetry.flush().catch(() => {});
  } catch {
    // A diagnostic must never mask the tool failure itself.
  }
}
