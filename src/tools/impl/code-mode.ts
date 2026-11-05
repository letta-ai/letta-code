import { rmSync } from "node:fs";
import { INTERRUPTED_BY_USER } from "@/constants";
import {
  createScriptToolScope,
  resolveScriptParentAgentId,
} from "@/tools/script-tool-scope";
import { formatWorkflowDuration } from "@/tools/workflow/format-stats";
import { executeToolScript } from "@/tools/workflow/workflow-engine";
import {
  addToMessageQueue,
  isQueueBridgeConnected,
} from "@/utils/message-queue-bridge";
import {
  formatTaskNotification,
  resolveNotificationScope,
} from "@/utils/task-notifications";
import {
  appendToOutputFile,
  assertBackgroundProcessCapacity,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextCodeModeId,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
} from "./process_manager.js";

interface CodeModeArgs {
  code: string;
  args?: unknown;
  run_in_background?: boolean;
  signal?: AbortSignal;
  parentScope?: { agentId: string; conversationId: string };
  /** Test-only override; not exposed in the CodeMode tool schema. */
  foregroundYieldMs?: number;
}

// Match Bash and exec_command's foreground yield.
const DEFAULT_FOREGROUND_YIELD_MS = 10_000;
const MAX_NOTIFICATION_RESULT_CHARS = 30_000;

type Outcome = { ok: true; text: string } | { ok: false; error: string };

function truncateResult(text: string): string {
  if (text.length <= MAX_NOTIFICATION_RESULT_CHARS) return text;
  const notice =
    "\n\n[CodeMode result truncated. Read the task output file for the full value.]";
  return `${text.slice(0, MAX_NOTIFICATION_RESULT_CHARS - notice.length)}${notice}`;
}

/**
 * Tool composition without Workflow metadata, model calls, or SDK setup.
 * Backgrounding mirrors Bash: wait briefly, then yield a task whose
 * completion arrives as a task notification.
 */
export async function code_mode(args: CodeModeArgs) {
  const {
    run_in_background = false,
    signal,
    foregroundYieldMs = DEFAULT_FOREGROUND_YIELD_MS,
  } = args;
  if (typeof args.code !== "string" || !args.code.trim()) {
    return {
      content: "Provide a non-empty JavaScript function body in code.",
      status: "error",
    };
  }
  // The turn's signal stops the script only while the call is in the
  // foreground; once yielded, TaskStop aborts it.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (!run_in_background) {
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
  }
  let scope: Awaited<ReturnType<typeof createScriptToolScope>>;
  try {
    assertBackgroundProcessCapacity();
    scope = await createScriptToolScope(
      await resolveScriptParentAgentId(args),
      controller.signal,
    );
  } catch (error) {
    signal?.removeEventListener("abort", forwardAbort);
    return {
      content: error instanceof Error ? error.message : String(error),
      status: "error",
    };
  }

  const taskId = getNextCodeModeId();
  const outputFile = createBackgroundOutputFile(taskId);
  const firstLine = args.code.trim().split("\n")[0] ?? "";
  const processState: BackgroundProcess = {
    process: {
      kill() {
        controller.abort(new Error("CodeMode stopped via TaskStop"));
      },
    },
    command: `CodeMode: ${firstLine.slice(0, 80)}`,
    status: "running",
    exitCode: null,
    startTime: new Date(),
    outputFile,
    runtimeScope: args.parentScope,
  };
  backgroundProcesses.set(taskId, processState);
  // Resolve now: by completion the launching turn may be gone.
  const notificationScope = resolveNotificationScope(args.parentScope);

  const output: string[] = [];
  const settled: Promise<Outcome> = executeToolScript({
    ...scope,
    script: args.code,
    args: args.args,
    signal: controller.signal,
    onProgress: (event) => {
      if (event.kind !== "log") return;
      output.push(event.message);
      appendToOutputFile(outputFile, `${event.message}\n`);
    },
  })
    .then((result): Outcome => {
      try {
        return { ok: true, text: JSON.stringify({ result, output }) };
      } catch (error) {
        return {
          ok: false,
          error: `Script result is not JSON-serializable: ${String(error)}`,
        };
      }
    })
    .catch(
      (error: unknown): Outcome => ({
        ok: false,
        error: controller.signal.aborted
          ? "CodeMode script stopped."
          : error instanceof Error
            ? error.message
            : String(error),
      }),
    )
    .then((outcome) => {
      processState.status = outcome.ok ? "completed" : "failed";
      processState.exitCode = outcome.ok ? 0 : 1;
      appendToOutputFile(
        outputFile,
        outcome.ok
          ? `\n[result]\n${outcome.text}\n`
          : `\n[error] ${outcome.error}\n`,
      );
      return outcome;
    })
    .finally(() => scope.cleanup());

  const notifyWhenSettled = () => {
    notifyBackgroundProcessStateChanged(notificationScope);
    void settled.then((outcome) => {
      notifyBackgroundProcessStateChanged(notificationScope);
      scheduleBackgroundProcessCleanup(taskId);
      if (processState.completionNotificationSuppressed) return;
      const status = outcome.ok ? "completed" : "failed";
      const durationMs = Date.now() - (processState.startTime?.getTime() ?? 0);
      addToMessageQueue({
        kind: "task_notification",
        text: formatTaskNotification({
          taskId,
          status,
          summary: `CodeMode script ${status} after ${formatWorkflowDuration(durationMs)}`,
          result: truncateResult(
            outcome.ok ? outcome.text : `CodeMode failed: ${outcome.error}`,
          ),
          outputFile,
          usage: { durationMs },
        }),
        ...notificationScope,
      });
    });
  };

  if (!run_in_background) {
    // One-shot headless runs have no queue consumer to receive a
    // notification, so there the script blocks until it settles.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = isQueueBridgeConnected()
      ? await Promise.race([
          settled,
          new Promise<"yield">((resolve) => {
            timer = setTimeout(() => resolve("yield"), foregroundYieldMs);
          }),
        ])
      : await settled;
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    if (first !== "yield") {
      backgroundProcesses.delete(taskId);
      rmSync(outputFile, { force: true });
      if (first.ok) return { content: first.text, status: "success" };
      return {
        content: signal?.aborted ? INTERRUPTED_BY_USER : first.error,
        status: "error",
      };
    }
    notifyWhenSettled();
    return {
      content: `CodeMode script is still running with task ID: ${taskId}\nOutput file: ${outputFile}\nYou will be notified when it completes. Do not poll unless you need intermediate output.`,
      status: "success",
    };
  }

  notifyWhenSettled();
  return {
    content: `CodeMode script running in background with ID: ${taskId}\nOutput file: ${outputFile}`,
    status: "success",
  };
}
