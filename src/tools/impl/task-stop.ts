import { getSubagents } from "@/agent/subagent-state.js";
import { getBackend } from "@/backend";
import { ApiRequestError } from "@/backend/api/request";
import { runWithRuntimeContext } from "@/runtime-context";
import { getErrorMessage } from "@/utils/error";
import { stopClaudeSession } from "./claude-stream-session";
import { stopCodexSession } from "./codex-app-server";
import { parseExternalCodingAgentId } from "./external-coding-agent.js";
import { killBackgroundProcess } from "./kill-bash.js";
import {
  type BackgroundTask,
  backgroundProcesses,
  backgroundTasks,
  scheduleBackgroundTaskCleanup,
} from "./process_manager.js";
import {
  REMOTE_EXTERNAL_WORKER_STOPPED,
  stopRemoteExternalCodingAgent,
} from "./remote-external-coding-agent.js";
import { stopConversationBackground } from "./stop-conversation-background";
import { validateRequiredParams } from "./validation.js";
import { cancelConversationWakes } from "./wake";

interface TaskStopArgs {
  task_id: string;
}

interface TaskStopResult {
  killed: boolean;
  output?: string;
}

/** Interrupt a remote child's conversation, as the UI's stop button does. */
async function cancelRemoteRun(
  subagentId: string,
  allowIdle = false,
): Promise<TaskStopResult> {
  const child = getSubagents().find((agent) => agent.id === subagentId);
  const target =
    child?.conversationId === "default" ? child.agentId : child?.conversationId;
  try {
    if (!target) throw new Error("its conversation is not known yet");
    const results = await getBackend().cancelConversation(target);
    const outcomes = Object.values(results);
    if (
      (!allowIdle && outcomes.length === 0) ||
      outcomes.some((status) => status !== "cancelled")
    ) {
      throw new Error("Cloud did not cancel every run");
    }
    return allowIdle
      ? { killed: true }
      : { killed: true, output: "Cancelled the remote run" };
  } catch (error) {
    // Local children can be between runs while their background work is live.
    if (allowIdle && error instanceof ApiRequestError && error.status === 409)
      return { killed: true };
    return {
      killed: false,
      output: `Couldn't cancel the remote run: ${getErrorMessage(error)}`,
    };
  }
}

/** Longest TaskStop waits for another computer to answer a stop request. */
const REMOTE_STOP_TIMEOUT_MS = 30_000;
/** Longest TaskStop waits for an aborted remote worker's task to settle. */
const COMPLETION_TIMEOUT_MS = 5_000;

const TIMED_OUT = Symbol("timed out");

/** Resolves with `promise`, or with `TIMED_OUT` once `timeoutMs` passes. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Retry schedule cleanup without re-aborting a process that already exited. */
async function finishPendingWakeCancellation(
  task: BackgroundTask,
): Promise<TaskStopResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await task.cancelPendingWakes?.();
      task.cancelPendingWakes = undefined;
      return { killed: true };
    } catch (error) {
      if (attempt === 1)
        return {
          killed: false,
          output: `The process stopped, but its wakes could not be cancelled: ${getErrorMessage(error)}. Retry TaskStop to cancel the wakes.`,
        };
    }
  }
  return { killed: false };
}

export async function task_stop(
  args: TaskStopArgs,
  deps: {
    stopRemoteExternal?: typeof stopRemoteExternalCodingAgent;
    remoteStopTimeoutMs?: number;
    completionTimeoutMs?: number;
  } = {},
): Promise<TaskStopResult> {
  validateRequiredParams(args, ["task_id"], "TaskStop");
  const { task_id } = args;

  // Check if this is a background Task (subagent)
  const task = backgroundTasks.get(task_id);
  if (task) {
    if (task.cancelPendingWakes) return finishPendingWakeCancellation(task);
    if (task.status === "running" && task.abortController) {
      const initialStop = task.stop;
      const child = getSubagents().find(
        (agent) => agent.id === task.subagentId,
      );
      const external = parseExternalCodingAgentId(child?.agentId ?? undefined);
      let remote: TaskStopResult | undefined;
      let remoteExternalStopped = false;
      if (task.stop) {
        try {
          const result = await withTimeout(
            task.stop(),
            deps.remoteStopTimeoutMs ?? REMOTE_STOP_TIMEOUT_MS,
          );
          if (result === TIMED_OUT)
            throw new Error(
              "The owning listener did not answer; the subagent may still be running",
            );
          remote = { killed: true };
        } catch (error) {
          remote = { killed: false, output: getErrorMessage(error) };
        }
      } else if (external?.computer) {
        try {
          if (!task.runtimeScope)
            throw new Error("its parent conversation is not known");
          const timeoutMs = deps.remoteStopTimeoutMs ?? REMOTE_STOP_TIMEOUT_MS;
          const stopping = (
            deps.stopRemoteExternal ?? stopRemoteExternalCodingAgent
          )({
            agentId: child?.agentId as string,
            parentScope: {
              agentId: task.runtimeScope.agentId,
              conversationId: task.runtimeScope.conversationId,
              actingUserId: task.actingUserId,
            },
          });
          stopping.catch(() => {});
          const result = await withTimeout(stopping, timeoutMs);
          if (result === TIMED_OUT)
            throw new Error(
              `${external.computer} did not answer within ${timeoutMs / 1000}s, so the worker may still be running`,
            );
          remote = {
            killed: result.stopped,
            output: result.stopped
              ? "Stopped the remote external subagent"
              : "The remote external subagent was not running",
          };
          remoteExternalStopped = result.stopped;
        } catch (error) {
          remote = {
            killed: false,
            output: `Couldn't stop the remote external subagent: ${getErrorMessage(error)}`,
          };
        }
      } else if (task.remote || (!external && child?.conversationId)) {
        remote = await cancelRemoteRun(task.subagentId, !task.remote);
      }
      if (remote && !remote.killed) return remote;
      try {
        if (external && !external.computer) {
          if (external.type === "claude-code")
            await stopClaudeSession(external.sessionId);
          if (external.type === "codex")
            await stopCodexSession(external.sessionId);
        }
      } catch (error) {
        return { killed: false, output: getErrorMessage(error) };
      }
      task.abortController.abort(
        remoteExternalStopped ? REMOTE_EXTERNAL_WORKER_STOPPED : undefined,
      );
      task.error = "Aborted by user";
      try {
        if (!task.completion && (task.remote || external || initialStop))
          throw new Error("Subagent process exit cannot be confirmed");
        const completionTimeoutMs =
          deps.completionTimeoutMs ??
          (external?.computer ? COMPLETION_TIMEOUT_MS : 10_000);
        const settled = task.completion
          ? await withTimeout(task.completion, completionTimeoutMs)
          : undefined;
        if (settled === TIMED_OUT) {
          if (!remoteExternalStopped)
            throw new Error("Subagent process exit was not confirmed");
          // The owning worker confirmed its process exit; only this follower's result is late.
          task.status = "failed";
          scheduleBackgroundTaskCleanup(task_id);
          return {
            killed: true,
            output: `${remote?.output ?? "Stopped the task"}, but stopped waiting for its result after ${completionTimeoutMs / 1000}s`,
          };
        }
      } catch (error) {
        return { killed: false, output: getErrorMessage(error) };
      }
      // The launcher can hand off to a listener while its abort unwinds.
      if (task.stop && task.stop !== initialStop) {
        try {
          const result = await withTimeout(
            task.stop(),
            deps.remoteStopTimeoutMs ?? REMOTE_STOP_TIMEOUT_MS,
          );
          if (result === TIMED_OUT)
            throw new Error("The owning listener did not confirm cancellation");
        } catch (error) {
          return { killed: false, output: getErrorMessage(error) };
        }
      }
      if (!external && !initialStop && child?.conversationId) {
        const agentId = child.agentId ?? child.parentAgentId;
        if (agentId) {
          const scope = { agentId, conversationId: child.conversationId };
          try {
            await stopConversationBackground(scope);
          } catch (error) {
            return { killed: false, output: getErrorMessage(error) };
          }
          // Process exit is confirmed even if schedule cleanup needs a retry.
          task.status = "failed";
          scheduleBackgroundTaskCleanup(task_id);
          task.cancelPendingWakes = () =>
            runWithRuntimeContext(
              {
                ...scope,
                actingUserId: task.actingUserId ?? undefined,
                suppressActingUserFallback: task.actingUserId === null,
              },
              () => cancelConversationWakes(scope),
            );
          const cleaned = await finishPendingWakeCancellation(task);
          if (!cleaned.killed) return cleaned;
        }
      }
      task.status = "failed";
      scheduleBackgroundTaskCleanup(task_id);
      return remote ?? { killed: true };
    }
    // Task exists but isn't running or doesn't have abort controller
    return { killed: false };
  }

  // Fall back to killing a Bash background process (bash shells share the
  // task id space).
  const process = backgroundProcesses.get(task_id);
  if (process?.cancel) return process.cancel();
  if (process?.remote && process.status === "running") {
    return {
      killed: false,
      output:
        "The server for this tool doesn't support cancelling, so the call may still finish; its result will still arrive as a notification.",
    };
  }
  const killed = killBackgroundProcess(task_id);
  return {
    killed,
    ...(killed && process?.kind === "tool" ? { output: "Stopped" } : {}),
  };
}
