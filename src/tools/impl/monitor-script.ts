import {
  getRuntimeActingUserAttribution,
  getRuntimeContext,
} from "@/runtime-context";
import {
  createScriptToolScope,
  resolveScriptParentAgentId,
} from "@/tools/script-tool-scope";
import {
  captureSecretRedactions,
  scrubSecretsFromString,
} from "@/tools/secret-substitution";
import {
  releaseRetainedToolContext,
  retainToolContext,
} from "@/tools/tool-context-retention";
import type { WorkflowToolCaller } from "@/tools/workflow/types";
import { executeToolScript } from "@/tools/workflow/workflow-engine";
import { addToMessageQueue } from "@/utils/message-queue-bridge";
import {
  formatTaskNotification,
  resolveNotificationScope,
} from "@/utils/task-notifications";
import { createMonitorEventStream } from "./monitor-event-stream";
import {
  assertBackgroundProcessCapacity,
  type BackgroundProcess,
  backgroundProcesses,
  createBackgroundOutputFile,
  getNextMonitorId,
  notifyBackgroundProcessStateChanged,
  unrefTimer,
} from "./process_manager";

// A watch loop runs for up to an hour (or indefinitely when persistent), so
// the lifetime cap that guards one-shot scripts would end healthy monitors.
// Bound the rate instead: bursts up to the bucket, then two calls per second.
const TOOL_CALL_BURST = 120;
const TOOL_CALL_REFILL_MS = 500;
const MAX_RESULT_CHARS = 30_000;

export interface ScriptMonitorArgs {
  description: string;
  script: string;
  args?: unknown;
  timeout_ms: number;
  persistent: boolean;
  parentScope?: { agentId: string; conversationId: string };
}

/** Helpers owned by monitor.ts, passed in to keep the module graph acyclic. */
export interface ScriptMonitorHooks {
  createOutput(path: string): { append(text: string): boolean };
  queueEvent(params: {
    taskId: string;
    event: string;
    scope: ReturnType<typeof resolveNotificationScope>;
    actingUserId?: string | null;
    secrets: Readonly<Record<string, string>>;
  }): void;
  markFinished(
    taskId: string,
    processState: BackgroundProcess,
    status: "completed" | "failed",
    exitCode: number | null,
  ): void;
  timeoutEvent(timeoutMs: number): string;
}

function rateLimitToolCalls(
  call: WorkflowToolCaller,
  signal: AbortSignal,
): WorkflowToolCaller {
  let tokens = TOOL_CALL_BURST;
  let refilledAt = Date.now();
  return (toolName, toolArgs) => {
    // After stop, park instead of rejecting so a catch-all loop can't spin.
    if (signal.aborted) return new Promise<never>(() => {});
    const now = Date.now();
    const refill = Math.floor((now - refilledAt) / TOOL_CALL_REFILL_MS);
    if (refill > 0) {
      tokens = Math.min(TOOL_CALL_BURST, tokens + refill);
      refilledAt += refill * TOOL_CALL_REFILL_MS;
    }
    if (tokens === 0) {
      throw new Error(
        `Monitor script exceeded ${1000 / TOOL_CALL_REFILL_MS} tool calls per second; add sleep() between polls.`,
      );
    }
    tokens -= 1;
    return call(toolName, toolArgs);
  };
}

// Once stopped, sleep never settles. A rejection would let a script that
// catches every error spin on microtasks and starve the event loop.
function abortableSleep(ms: unknown, signal: AbortSignal): Promise<void> {
  const delay = Number(ms);
  if (!Number.isFinite(delay) || delay < 0) {
    return Promise.reject(new Error("sleep(ms) needs a non-negative number."));
  }
  return new Promise((resolve) => {
    if (signal.aborted) return;
    const onAbort = () => clearTimeout(timer);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function formatReturnValue(value: unknown): string {
  if (value === undefined) return "The script returned without a value.";
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch (error) {
    return `The script returned a value that is not JSON-serializable: ${String(error)}`;
  }
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated; see the output file]`;
}

async function releaseToolContext(contextId: string | null): Promise<void> {
  if (!contextId || !releaseRetainedToolContext(contextId)) return;
  // The manager loads tool implementations; a static import would cycle.
  const manager = await import("@/tools/manager");
  manager.releaseToolExecutionContext(contextId);
}

/**
 * A JavaScript watch loop with CodeMode's tool bindings. `emit(text)` raises
 * one event through the same batching and rate limits as command stdout;
 * returning ends the monitor as completed and throwing ends it as failed.
 */
export async function startScriptMonitor(
  args: ScriptMonitorArgs,
  hooks: ScriptMonitorHooks,
): Promise<{ taskId: string; outputFile: string }> {
  assertBackgroundProcessCapacity();
  // The launching turn may end, and release its tool context, long before
  // the loop does. Hold it until the monitor settles.
  const toolContextId = getRuntimeContext()?.toolContextId ?? null;
  if (toolContextId) retainToolContext(toolContextId);
  const controller = new AbortController();
  const parentAgentId = await resolveScriptParentAgentId(args).catch(
    async (error: unknown) => {
      await releaseToolContext(toolContextId);
      throw error;
    },
  );
  const toolScope = await createScriptToolScope(
    parentAgentId,
    controller.signal,
  ).catch(async (error: unknown) => {
    await releaseToolContext(toolContextId);
    throw error;
  });

  const taskId = getNextMonitorId();
  const outputFile = createBackgroundOutputFile(taskId);
  const output = hooks.createOutput(outputFile);
  const scope = resolveNotificationScope(args.parentScope);
  const actingUserId = getRuntimeActingUserAttribution();
  const secrets = captureSecretRedactions(parentAgentId ?? undefined);
  const scrub = (text: string) => scrubSecretsFromString(text, secrets);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const stop = (reason: string, note?: string): void => {
    if (processState.status !== "running") return;
    processState.completionNotificationSuppressed = true;
    if (note) output.append(note);
    hooks.markFinished(taskId, processState, "failed", null);
    controller.abort(new Error(reason));
  };

  const events = createMonitorEventStream({
    emit(event) {
      hooks.queueEvent({ taskId, event, scope, actingUserId, secrets });
    },
    stopSource() {
      stop("output rate too high", "\n[stopped: output rate too high]\n");
    },
  });

  const firstLine = args.script.trim().split("\n")[0] ?? "";
  const processState: BackgroundProcess = {
    process: {
      kill() {
        events.cancel();
        controller.abort(new Error("Monitor stopped via TaskStop"));
      },
    },
    command: `script: ${firstLine.slice(0, 80)}`,
    status: "running",
    exitCode: null,
    startTime: new Date(),
    outputFile,
    runtimeScope: scope,
    actingUserId,
    kind: "monitor",
    description: args.description,
    monitorSource: "script",
    persistent: args.persistent,
    secrets,
  };
  backgroundProcesses.set(taskId, processState);
  notifyBackgroundProcessStateChanged(scope);

  const emit = (value: unknown): void => {
    if (processState.status !== "running") return;
    const text = scrub(typeof value === "string" ? value : String(value));
    if (!text.trim()) return;
    const line = text.endsWith("\n") ? text : `${text}\n`;
    if (!output.append(line)) {
      stop("output file write failed");
      return;
    }
    events.onData(line);
  };

  const finish = (status: "completed" | "failed", detail: string): void => {
    events.finish();
    output.append(
      `\n[${status === "completed" ? "result" : "error"}] ${detail}\n`,
    );
    if (processState.status !== "running") return;
    hooks.markFinished(
      taskId,
      processState,
      status,
      status === "completed" ? 0 : 1,
    );
    const durationMs = Date.now() - (processState.startTime?.getTime() ?? 0);
    addToMessageQueue({
      kind: "task_notification",
      text: formatTaskNotification({
        taskId,
        status,
        summary:
          status === "completed"
            ? `Monitor "${args.description}" script returned`
            : `Monitor "${args.description}" script failed`,
        result: detail,
        outputFile,
        usage: { durationMs },
      }),
      ...scope,
      ...(actingUserId !== undefined ? { actingUserId } : {}),
    });
  };

  // The engine rejects every call once its signal aborts, which a catch-all
  // loop would spin on. Give it a signal that never aborts and settle the
  // monitor on our own abort; stopped calls and sleeps park instead.
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  const run = executeToolScript({
    ...toolScope,
    callTool: rateLimitToolCalls(toolScope.callTool, controller.signal),
    maxTotalToolCalls: Number.POSITIVE_INFINITY,
    script: args.script,
    args: args.args,
    signal: new AbortController().signal,
    globals: {
      emit,
      sleep: (ms: unknown) => abortableSleep(ms, controller.signal),
    },
    onProgress: (event) => {
      if (event.kind === "log") output.append(`${scrub(event.message)}\n`);
    },
  });
  void run.catch(() => {});
  void Promise.race([run, stopped])
    .then(
      (value) => finish("completed", scrub(formatReturnValue(value))),
      (error: unknown) =>
        finish(
          "failed",
          scrub(error instanceof Error ? error.message : String(error)),
        ),
    )
    .finally(async () => {
      if (timeout) clearTimeout(timeout);
      await toolScope.cleanup();
      await releaseToolContext(toolContextId);
    });

  if (!args.persistent) {
    timeout = setTimeout(() => {
      if (processState.status !== "running") return;
      events.finish();
      hooks.queueEvent({
        taskId,
        event: hooks.timeoutEvent(args.timeout_ms),
        scope,
        actingUserId,
        secrets,
      });
      stop("timeout", `\n[timeout after ${args.timeout_ms}ms]\n`);
    }, args.timeout_ms);
    unrefTimer(timeout);
  }

  return { taskId, outputFile };
}
