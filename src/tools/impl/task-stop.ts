import { getSubagents } from "@/agent/subagent-state.js";
import { getBackend } from "@/backend";
import { getErrorMessage } from "@/utils/error";
import { killBackgroundProcess } from "./kill-bash.js";
import {
  backgroundTasks,
  scheduleBackgroundTaskCleanup,
} from "./process_manager.js";
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
    await getBackend().cancelConversation(target);
    return { killed: true, output: "Cancelled the remote run" };
  } catch (error) {
    return {
      killed: false,
      output: `Couldn't cancel the remote run: ${getErrorMessage(error)}`,
    };
  }
}

export async function task_stop(args: TaskStopArgs): Promise<TaskStopResult> {
  validateRequiredParams(args, ["task_id"], "TaskStop");
  const { task_id } = args;

  // Check if this is a background Task (subagent)
  const task = backgroundTasks.get(task_id);
  if (task) {
    if (task.status === "running" && task.abortController) {
      const remote = task.remote
        ? await cancelRemoteRun(task.subagentId)
        : undefined;
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
