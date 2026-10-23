import { rmSync } from "node:fs";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { INTERRUPTED_BY_USER } from "@/constants";
import { createSdkSpawnerHandle } from "@/tools/impl/workflow";
import { ReplSession, type ReplSessionDeps } from "@/tools/repl/repl-session";
import type { ReplTurnRecord, ReplWorker } from "@/tools/repl/repl-worker";
import {
  createScriptToolScope,
  resolveScriptParentAgentId,
} from "@/tools/script-tool-scope";
import { formatWorkflowDuration } from "@/tools/workflow/format-stats";
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
  getNextReplCellId,
  notifyBackgroundProcessStateChanged,
  scheduleBackgroundProcessCleanup,
} from "./process_manager.js";

interface ReplArgs {
  code?: string;
  args?: unknown;
  reset?: boolean;
  run_in_background?: boolean;
  signal?: AbortSignal;
  parentScope?: { agentId: string; conversationId: string };
  /** Test-only override; not exposed in the Repl tool schema. */
  foregroundYieldMs?: number;
}

// Match Bash, exec_command, and CodeMode's foreground yield.
const DEFAULT_FOREGROUND_YIELD_MS = 10_000;
const MAX_NOTIFICATION_RESULT_CHARS = 30_000;

type Outcome = { ok: true; text: string } | { ok: false; error: string };

/** One session per invoking conversation; variables and workers persist across cells. */
const sessions = new Map<string, ReplSession>();

type SessionFactory = (
  args: ReplArgs,
  onWorkerSettled: ReplSessionDeps["onWorkerSettled"],
) => ReplSession;

function createProductionSession(
  args: ReplArgs,
  onWorkerSettled: ReplSessionDeps["onWorkerSettled"],
): ReplSession {
  return new ReplSession({
    createSpawner: () =>
      createSdkSpawnerHandle({
        ...(args.parentScope ? { parentScope: args.parentScope } : {}),
      }),
    onWorkerSettled,
  });
}

let sessionFactory: SessionFactory = createProductionSession;

/** Swap the session backend (tests inject a fake spawner). */
export function __setReplSessionFactoryForTests(
  factory: SessionFactory | null,
): void {
  sessionFactory = factory ?? createProductionSession;
}

/** Close every session (tests and shutdown). */
export async function closeAllReplSessions(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(open.map((session) => session.close()));
}

function sessionKey(args: ReplArgs): string {
  if (args.parentScope) {
    return `${args.parentScope.agentId}:${args.parentScope.conversationId || "default"}`;
  }
  let agentId = "unknown-agent";
  try {
    agentId = getCurrentAgentId();
  } catch {}
  return `${agentId}:${getConversationId() ?? "default"}`;
}

function truncate(text: string, notice: string): string {
  if (text.length <= MAX_NOTIFICATION_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_NOTIFICATION_RESULT_CHARS - notice.length)}${notice}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

function getOrCreateSession(args: ReplArgs): ReplSession {
  const key = sessionKey(args);
  const existing = sessions.get(key);
  if (existing && !existing.isClosed) return existing;
  const notificationScope = resolveNotificationScope(args.parentScope);
  // Notify only when no cell is watching: a cell awaiting the worker already
  // receives its result, and a yielded cell notifies on its own completion.
  const onWorkerSettled = (worker: ReplWorker, turn: ReplTurnRecord) => {
    if (session.activeCells > 0) return;
    const ok = turn.status === "done";
    addToMessageQueue({
      kind: "task_notification",
      text: formatTaskNotification({
        taskId: `repl_${worker.id}`,
        status: ok ? "completed" : "failed",
        summary: `Repl worker ${worker.id} (${worker.label}) ${ok ? "finished" : "failed"} turn ${turn.index + 1}${
          turn.durationMs !== undefined
            ? ` after ${formatWorkflowDuration(turn.durationMs)}`
            : ""
        }; read it with agent.get("${worker.id}") in a Repl cell`,
        result: truncate(
          ok ? stringify(turn.value) : `Worker failed: ${turn.error}`,
          "\n\n[Worker result truncated. Read it from agent.get(...).info() in a Repl cell.]",
        ),
        usage: {
          ...(turn.durationMs !== undefined
            ? { durationMs: turn.durationMs }
            : {}),
          ...(turn.totalTokens !== undefined
            ? { totalTokens: turn.totalTokens }
            : {}),
        },
      }),
      ...notificationScope,
    });
  };
  const session = sessionFactory(args, onWorkerSettled);
  sessions.set(key, session);
  return session;
}

/**
 * A persistent JavaScript session for programmatic tool calls and steerable
 * subagents. Backgrounding mirrors CodeMode: wait briefly, then yield a task
 * whose completion arrives as a task notification.
 */
export async function repl(args: ReplArgs) {
  const {
    run_in_background = false,
    signal,
    foregroundYieldMs = DEFAULT_FOREGROUND_YIELD_MS,
  } = args;
  const code = typeof args.code === "string" ? args.code : "";
  if (args.reset) {
    const key = sessionKey(args);
    const session = sessions.get(key);
    sessions.delete(key);
    await session?.close();
    if (!code.trim()) {
      return {
        content: session
          ? "Repl session reset; its workers were stopped."
          : "No Repl session to reset.",
        status: "success",
      };
    }
  }
  if (!code.trim()) {
    return {
      content: "Provide non-empty JavaScript in code, or reset: true.",
      status: "error",
    };
  }

  // The turn's signal stops the cell only while it is in the foreground;
  // once yielded, TaskStop aborts it. Workers belong to the session and
  // keep running either way.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (!run_in_background) {
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
  }
  let scope: Awaited<ReturnType<typeof createScriptToolScope>>;
  let session: ReplSession;
  try {
    assertBackgroundProcessCapacity();
    session = getOrCreateSession(args);
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

  const taskId = getNextReplCellId();
  const outputFile = createBackgroundOutputFile(taskId);
  const firstLine = code.trim().split("\n")[0] ?? "";
  const processState: BackgroundProcess = {
    process: {
      kill() {
        controller.abort(new Error("Repl cell stopped via TaskStop"));
      },
    },
    command: `Repl: ${firstLine.slice(0, 80)}`,
    status: "running",
    exitCode: null,
    startTime: new Date(),
    outputFile,
    runtimeScope: args.parentScope,
  };
  backgroundProcesses.set(taskId, processState);
  // Resolve now: by completion the launching turn may be gone.
  const notificationScope = resolveNotificationScope(args.parentScope);

  const settled: Promise<Outcome> = session
    .runCell(code, {
      args: args.args,
      signal: controller.signal,
      scope,
      onLog: (message) => appendToOutputFile(outputFile, `${message}\n`),
    })
    .then(({ result, output }): Outcome => {
      const workers = session.workerInfo().map((worker) => ({
        id: worker.id,
        label: worker.label,
        status: worker.status,
        conversationId: worker.conversationId,
      }));
      try {
        return {
          ok: true,
          text: JSON.stringify({
            result,
            output,
            ...(workers.length ? { workers } : {}),
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error: `Cell result is not JSON-serializable: ${String(error)}`,
        };
      }
    })
    .catch(
      (error: unknown): Outcome => ({
        ok: false,
        error: controller.signal.aborted
          ? "Repl cell stopped. Workers it started keep running; stop them with agent.get(id).stop() or reset: true."
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
    });

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
          summary: `Repl cell ${status} after ${formatWorkflowDuration(durationMs)}`,
          result: truncate(
            outcome.ok ? outcome.text : `Repl failed: ${outcome.error}`,
            "\n\n[Repl result truncated. Read the task output file for the full value.]",
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
    // notification, so there the cell blocks until it settles.
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
      content: `Repl cell is still running with task ID: ${taskId}\nOutput file: ${outputFile}\nYou will be notified when it completes. Do not poll unless you need intermediate output.`,
      status: "success",
    };
  }

  notifyWhenSettled();
  return {
    content: `Repl cell running in background with ID: ${taskId}\nOutput file: ${outputFile}`,
    status: "success",
  };
}
