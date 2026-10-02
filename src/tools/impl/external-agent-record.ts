/**
 * Durable record of in-flight external coding agent (Claude Code / Codex) tasks.
 *
 * `backgroundTasks` in `process_manager.ts` is in-memory, so a sandbox or
 * listener restart kills the child process and loses the task entirely: the
 * parent conversation never receives the completion or failure
 * `<task-notification>` it was promised, and nothing tells it that a resumable
 * native session is sitting there half-finished.
 *
 * Each running task therefore leaves a small file under
 * `~/.letta/external-agent-tasks/<server>/`. The owning runtime removes it on
 * normal completion or failure (those paths already notify). On listener start
 * `reportInterruptedExternalCodingAgentTasks` sweeps whatever is left behind by
 * a process that is no longer alive and delivers the missing notification with
 * the ID the parent needs to resume.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { updateSubagent } from "@/agent/subagent-state";
import { getServerUrl } from "@/backend/api/server-url";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { debugWarn } from "@/utils/debug";
import { addToMessageQueue } from "@/utils/message-queue-bridge";
import { formatTaskNotification } from "@/utils/task-notifications";
import {
  type ExternalCodingAgentType,
  isExternalCodingAgentType,
  parseExternalCodingAgentId,
} from "./external-coding-agent";
import type { BackgroundTask } from "./process_manager";

export interface ExternalCodingAgentTaskRecord {
  taskId: string;
  subagentId: string;
  type: ExternalCodingAgentType;
  /** Synthetic ID the parent resumes with, once the session is known. */
  agentId?: string;
  /** Native Claude/Codex session UUID behind `agentId`. */
  nativeSessionId?: string;
  cwd: string;
  description: string;
  parentAgentId: string;
  parentConversationId: string;
  actingUserId?: string;
  startedAt: string;
  /** Runtime that owns this task; its liveness is what decides staleness. */
  hostPid: number;
  /**
   * Linux-only identity of the owning runtime. A sandbox restart can hand the
   * old PID to an unrelated process, so a live PID alone would hide the
   * interruption forever. Absent on platforms without `/proc`.
   */
  hostBootId?: string;
  hostStartTicks?: string;
}

/** Records this process owns, so its own files are never swept as stale. */
const owned = new Map<string, ExternalCodingAgentTaskRecord>();

let directoryOverride: string | undefined;

function defaultDirectory(): string {
  let scope = "default";
  try {
    scope = createHash("sha256")
      .update(getServerUrl())
      .digest("hex")
      .slice(0, 24);
  } catch {
    // Settings may not be initialized yet; a shared bucket still routes fine.
  }
  return join(homedir(), ".letta", "external-agent-tasks", scope);
}

export function createExternalCodingAgentTaskStore(
  directory = directoryOverride ?? defaultDirectory(),
) {
  function path(hostPid: number, subagentId: string): string {
    return join(directory, `${hostPid}-${encodeURIComponent(subagentId)}.json`);
  }

  function readRecord(file: string): ExternalCodingAgentTaskRecord | null {
    try {
      const value = JSON.parse(
        readFileSync(file, "utf8"),
      ) as ExternalCodingAgentTaskRecord;
      if (
        !value ||
        typeof value.taskId !== "string" ||
        typeof value.subagentId !== "string" ||
        typeof value.type !== "string" ||
        !isExternalCodingAgentType(value.type) ||
        typeof value.cwd !== "string" ||
        typeof value.description !== "string" ||
        typeof value.parentAgentId !== "string" ||
        typeof value.parentConversationId !== "string" ||
        typeof value.startedAt !== "string" ||
        !Number.isInteger(value.hostPid) ||
        path(value.hostPid, value.subagentId) !== file
      ) {
        throw new Error("Invalid external coding agent task record");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        debugWarn(
          "recovery",
          "Ignoring unreadable external coding agent task record",
          file,
        );
      }
      return null;
    }
  }

  return {
    list(): ExternalCodingAgentTaskRecord[] {
      try {
        return readdirSync(directory)
          .filter((file) => file.endsWith(".json"))
          .map((file) => readRecord(join(directory, file)))
          .filter(
            (record): record is ExternalCodingAgentTaskRecord =>
              record !== null,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    write(record: ExternalCodingAgentTaskRecord): void {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const destination = path(record.hostPid, record.subagentId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(record), {
          mode: 0o600,
          flush: true,
        });
        renameSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    /**
     * Take ownership of a record before acting on it. Unlink is atomic, so
     * concurrent listeners sweeping the same directory produce exactly one
     * winner and the parent is woken once.
     */
    claim(record: ExternalCodingAgentTaskRecord): boolean {
      try {
        unlinkSync(path(record.hostPid, record.subagentId));
        return true;
      } catch {
        return false;
      }
    },
    remove(hostPid: number, subagentId: string): void {
      rmSync(path(hostPid, subagentId), { force: true });
    },
  };
}

function writeOwnedRecord(record: ExternalCodingAgentTaskRecord): void {
  try {
    createExternalCodingAgentTaskStore().write(record);
  } catch (error) {
    // Losing the breadcrumb must never fail the task it describes.
    debugWarn("recovery", "Failed to record external coding agent task", error);
  }
}

/**
 * Note that an external coding agent task is in flight.
 *
 * Returns the cleanup to run once the task reaches a terminal state, where the
 * normal completion/failure notification already covers the parent. Non-external
 * subagents and tasks without a parent scope to notify get a no-op.
 */
export function recordExternalCodingAgentTask(
  taskId: string,
  task: BackgroundTask,
  existingAgentId?: string,
): () => void {
  if (!isExternalCodingAgentType(task.subagentType) || !task.runtimeScope) {
    return () => {};
  }
  const resumed = existingAgentId
    ? parseExternalCodingAgentId(existingAgentId)
    : null;
  const record: ExternalCodingAgentTaskRecord = {
    taskId,
    subagentId: task.subagentId,
    type: task.subagentType,
    agentId: resumed ? existingAgentId : undefined,
    nativeSessionId: resumed?.sessionId,
    cwd: getCurrentWorkingDirectory(),
    description: task.description,
    parentAgentId: task.runtimeScope.agentId,
    parentConversationId: task.runtimeScope.conversationId,
    actingUserId: task.actingUserId,
    startedAt: task.startTime.toISOString(),
    hostPid: process.pid,
    ...currentHostIdentity(),
  };
  owned.set(record.subagentId, record);
  writeOwnedRecord(record);
  return () => {
    owned.delete(record.subagentId);
    try {
      createExternalCodingAgentTaskStore().remove(
        record.hostPid,
        record.subagentId,
      );
    } catch (error) {
      debugWarn(
        "recovery",
        "Failed to clear external coding agent task",
        error,
      );
    }
  };
}

/**
 * Bind a running subagent to the external session it drives, in live state and
 * in the durable record, so an interrupted task can still name its resume ID.
 */
export function bindExternalCodingAgentSession(
  subagentId: string,
  agentId: string,
): void {
  updateSubagent(subagentId, { agentId, status: "running" });
  const record = owned.get(subagentId);
  if (!record || record.agentId === agentId) return;
  record.agentId = agentId;
  record.nativeSessionId = parseExternalCodingAgentId(agentId)?.sessionId;
  writeOwnedRecord(record);
}

function readBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Field 22 of `/proc/<pid>/stat`: start time in clock ticks since boot. */
function readProcessStartTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may contain spaces; fields after it don't.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}

function currentHostIdentity(): Pick<
  ExternalCodingAgentTaskRecord,
  "hostBootId" | "hostStartTicks"
> {
  return {
    hostBootId: readBootId(),
    hostStartTicks: readProcessStartTicks(process.pid),
  };
}

/**
 * Whether the runtime that wrote a record is still running. A matching PID is
 * not enough after a restart: the boot ID or the process start time must also
 * match whenever the record carries them.
 */
export function isExternalCodingAgentTaskHostAlive(
  record: Pick<
    ExternalCodingAgentTaskRecord,
    "hostPid" | "hostBootId" | "hostStartTicks"
  >,
): boolean {
  const pid = record.hostPid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the PID exists but belongs to another user.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (record.hostBootId) {
    const bootId = readBootId();
    if (bootId && bootId !== record.hostBootId) return false;
  }
  if (record.hostStartTicks) {
    const startTicks = readProcessStartTicks(pid);
    if (startTicks && startTicks !== record.hostStartTicks) return false;
  }
  return true;
}

function describeInterruption(record: ExternalCodingAgentTaskRecord): string {
  const header = [
    `subagent_type=${record.type}`,
    `subagent_id=${record.subagentId}`,
    "subagent_status=error",
    record.agentId ? `agent_id=${record.agentId}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const resume = record.agentId
    ? `Resume with SendAgentMessage to \`${record.agentId}\`;`
    : "No resumable session was recorded before the restart;";
  return `${header}\n\nInterrupted by a runtime restart before finishing. ${resume} work in \`${record.cwd}\` may be uncommitted.`;
}

/**
 * Deliver the notification an interrupted external coding agent task never
 * sent, then forget it. Safe to call repeatedly and from concurrent listeners:
 * records are claimed by deletion, and records whose owning runtime is still
 * alive are left untouched.
 *
 * Returns the number of parents notified.
 */
export function reportInterruptedExternalCodingAgentTasks(
  deps: {
    store?: ReturnType<typeof createExternalCodingAgentTaskStore>;
    isHostAlive?: (record: ExternalCodingAgentTaskRecord) => boolean;
    enqueue?: typeof addToMessageQueue;
  } = {},
): number {
  const store = deps.store ?? createExternalCodingAgentTaskStore();
  const isHostAlive = deps.isHostAlive ?? isExternalCodingAgentTaskHostAlive;
  const enqueue = deps.enqueue ?? addToMessageQueue;
  let reported = 0;
  let records: ExternalCodingAgentTaskRecord[];
  try {
    records = store.list();
  } catch (error) {
    debugWarn("recovery", "Failed to list external coding agent tasks", error);
    return 0;
  }
  for (const record of records) {
    if (owned.has(record.subagentId)) continue;
    // A record carrying our own PID cannot describe live work: this process
    // tracks everything it starts in `owned`, so the PID was simply recycled.
    if (record.hostPid !== process.pid && isHostAlive(record)) continue;
    if (!store.claim(record)) continue;
    enqueue({
      kind: "task_notification",
      text: formatTaskNotification({
        taskId: record.taskId,
        status: "failed",
        summary: `Agent "${record.description}" was interrupted by a runtime restart`,
        result: describeInterruption(record),
      }),
      agentId: record.parentAgentId,
      conversationId: record.parentConversationId,
      actingUserId: record.actingUserId,
    });
    reported += 1;
  }
  return reported;
}

export function __setExternalCodingAgentTaskDirectoryForTests(
  directory: string | undefined,
): void {
  directoryOverride = directory;
  owned.clear();
}
