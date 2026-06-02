import { getTask, type TaskRecord } from "./tasks/store.js";
import { validateRequiredParams } from "./validation.js";

interface TaskGetArgs {
  taskId?: string;
}

export async function task_get(args: TaskGetArgs): Promise<TaskRecord> {
  validateRequiredParams(args, ["taskId"], "TaskGet");
  if (typeof args.taskId !== "string" || args.taskId.length === 0) {
    throw new Error("TaskGet: 'taskId' must be a non-empty string");
  }
  const record = getTask(args.taskId);
  if (!record) {
    throw new Error(`TaskGet: task not found: ${args.taskId}`);
  }
  return record;
}
