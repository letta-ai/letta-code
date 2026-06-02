import { listTasks, type TaskRecord } from "./tasks/store.js";

interface TaskListResult {
  tasks: TaskRecord[];
}

export async function task_list(
  _args: Record<string, unknown>,
): Promise<TaskListResult> {
  return { tasks: listTasks() };
}
