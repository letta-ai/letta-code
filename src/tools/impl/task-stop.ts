import { getSubagents } from "@/agent/subagent-state.js";
import { getBackend } from "@/backend";
import { getErrorMessage } from "@/utils/error";
import { parseExternalCodingAgentId } from "./external-coding-agent.js";
import { killBackgroundProcess } from "./kill-bash.js";
import {
  backgroundTasks,
  scheduleBackgroundTaskCleanup,
} from "./process_manager.js";
import { stopRemoteExternalCodingAgent } from "./remote-external-coding-agent.js";
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

export async function task_stop(
  args: TaskStopArgs,
  deps: { stopRemoteExternal?: typeof stopRemoteExternalCodingAgent } = {},
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
      if (external?.computer) {
        try {
          if (!task.runtimeScope)
            throw new Error("its parent conversation is not known");
          const result = await (
            deps.stopRemoteExternal ?? stopRemoteExternalCodingAgent
          )({
            agentId: child?.agentId as string,
            parentScope: {
              agentId: task.runtimeScope.agentId,
              conversationId: task.runtimeScope.conversationId,
              actingUserId: task.actingUserId,
            },
          });
          remote = {
            killed: result.stopped,
            output: result.stopped
              ? "Stopped the remote external subagent"
              : "The remote external subagent was not running",
          };
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
      task.abortController.abort();
      task.error = "Aborted by user";
      await task.completion;
      task.status = "failed";
      scheduleBackgroundTaskCleanup(task_id);
      return remote ?? { killed: true };
    }
    // Task exists but isn't running or doesn't have abort controller
    return { killed: false };
  }

  // Fall back to killing a Bash background process (bash shells share the
  // task id space).
  return { killed: killBackgroundProcess(task_id) };
}
