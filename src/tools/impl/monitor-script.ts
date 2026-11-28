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
import { submitWorkflowDecision } from "@/tools/workflow/decide";
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

const TOOL_CALL_BURST = 120;
const TOOL_CALL_REFILL_MS = 500;
const MAX_RESULT_CHARS = 30_000;

export interface ScriptMonitorArgs {
  taskId?: string;
  description: string;
  script: string;
  args?: unknown;
  timeout_ms: number;
  persistent: boolean;
  parentScope?: { agentId: string; conversationId: string };
}

export interface ScriptMonitorHooks {
  createOutput(path: string): { append(text: string): boolean };
  queueEvent(params: {
    taskId: string;
    description?: string;
    event: string;
    scope: ReturnType<typeof resolveNotificationScope>;
    actingUserId?: string | null;
    secrets: Readonly<Record<string, string>>;
  }): void;
  markFinished(
    taskId: string,
    processState: BackgroundProcess,
    status: "completed" | "failed" | "expired",
    exitCode: number | null,
  ): void;
  timeoutEvent(timeoutMs: number): string;
}

function createCallLimiter(signal: AbortSignal) {
  let tokens = TOOL_CALL_BURST;
  let refilledAt = Date.now();
  return <T>(call: () => Promise<T>): Promise<T> => {
    if (signal.aborted) return new Promise<never>(() => {});
    const now = Date.now();
    const refill = Math.floor((now - refilledAt) / TOOL_CALL_REFILL_MS);
    if (refill > 0) {
      tokens = Math.min(TOOL_CALL_BURST, tokens + refill);
      refilledAt += refill * TOOL_CALL_REFILL_MS;
    }
    if (tokens === 0) {
      throw new Error(
        `Monitor script exceeded ${1000 / TOOL_CALL_REFILL_MS} calls per second; add sleep() between polls.`,
      );
    }
    tokens -= 1;
    return call();
  };
}

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
  const manager = await import("@/tools/manager");
  manager.releaseToolExecutionContext(contextId);
}

export async function startScriptMonitor(
  args: ScriptMonitorArgs,
  hooks: ScriptMonitorHooks,
): Promise<{ taskId: string; outputFile: string }> {
  assertBackgroundProcessCapacity();
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

  const taskId = args.taskId ?? getNextMonitorId();
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
    hooks.markFinished(
      taskId,
      processState,
      reason === "timeout" ? "expired" : "failed",
      null,
    );
    controller.abort(new Error(reason));
  };

  const events = createMonitorEventStream({
    emit(event) {
      hooks.queueEvent({
        taskId,
        description: args.description,
        event,
        scope,
        actingUserId,
        secrets,
      });
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
    hooks.markFinished(
      taskId,
      processState,
      status,
      status === "completed" ? 0 : 1,
    );
  };

  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  const limit = createCallLimiter(controller.signal);
  const run = executeToolScript({
    ...toolScope,
    callTool: (toolName, toolArgs) =>
      limit(() => toolScope.callTool(toolName, toolArgs)),
    maxTotalToolCalls: Number.POSITIVE_INFINITY,
    script: args.script,
    args: args.args,
    signal: new AbortController().signal,
    globals: {
      emit,
      sleep: (ms: unknown) => abortableSleep(ms, controller.signal),
      decide: (state: unknown, questions: unknown, options?: unknown) => {
        if (
          options !== undefined &&
          (!options || typeof options !== "object" || Array.isArray(options))
        ) {
          throw new Error("decide() options must be an object.");
        }
        const pending = limit(() =>
          submitWorkflowDecision(
            { ...(options as object | undefined), state, questions },
            controller.signal,
          ),
        );
        void pending.catch(() => {});
        return pending;
      },
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
        description: args.description,
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
