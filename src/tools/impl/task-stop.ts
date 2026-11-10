import { getSubagents } from "@/agent/subagent-state.js";
import { getBackend } from "@/backend";
import { getErrorMessage } from "@/utils/error";
import { parseExternalCodingAgentId } from "./external-coding-agent.js";
import { killBackgroundProcess } from "./kill-bash.js";
import {
  backgroundProcesses,
  backgroundTasks,
  scheduleBackgroundTaskCleanup,
} from "./process_manager.js";
import {
  REMOTE_EXTERNAL_WORKER_STOPPED,
  stopRemoteExternalCodingAgent,
} from "./remote-external-coding-agent.js";
import { validateRequiredParams } from "./validation.js";

interface TaskStopArgs {
  task_id: string;
}

interface TaskStopResult {
  killed: boolean;
  output?: string;
}

/** Interrupt a remote child's conversation, as the UI's stop button does. */
async function cancelRemoteRun(subagentId: string): Promise<TaskStopResult> {
  const child = getSubagents().find((agent) => agent.id === subagentId);
  const target =
    child?.conversationId === "default" ? child.agentId : child?.conversationId;
  try {
    if (!target) throw new Error("its conversation is not known yet");
    const results = await getBackend().cancelConversation(target);
    const outcomes = Object.values(results);
    if (
      outcomes.length === 0 ||
      outcomes.some((status) => status !== "cancelled")
    ) {
      throw new Error("Cloud did not cancel every run");
    }
    return { killed: true, output: "Cancelled the remote run" };
  } catch (error) {
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
    if (task.status === "running" && task.abortController) {
      const child = getSubagents().find(
        (agent) => agent.id === task.subagentId,
      );
      const external = parseExternalCodingAgentId(child?.agentId ?? undefined);
      let remote: TaskStopResult | undefined;
      let remoteExternalStopped = false;
      if (external?.computer) {
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
          // A stop that settles after the timeout has nobody left to report to.
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
      } else if (task.remote) {
        remote = await cancelRemoteRun(task.subagentId);
      }
      if (remote && !remote.killed) return remote;
      task.abortController.abort(
        remoteExternalStopped ? REMOTE_EXTERNAL_WORKER_STOPPED : undefined,
      );
      task.error = "Aborted by user";
      // A remote follower can be stuck reconnecting; don't let it hold the turn.
      const completionTimeoutMs =
        deps.completionTimeoutMs ?? COMPLETION_TIMEOUT_MS;
      const settled = external?.computer
        ? await withTimeout(
            Promise.resolve(task.completion),
            completionTimeoutMs,
          )
        : await task.completion;
      task.status = "failed";
      scheduleBackgroundTaskCleanup(task_id);
      if (settled === TIMED_OUT)
        return {
          killed: true,
          output: `${remote?.output ?? "Stopped the task"}, but stopped waiting for its result after ${completionTimeoutMs / 1000}s`,
        };
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
