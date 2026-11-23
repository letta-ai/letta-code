import { getTaskSnapshot, type TaskSnapshot } from "./tasks/store.js";

export async function task_list(
  _args: Record<string, unknown>,
): Promise<TaskSnapshot> {
  return getTaskSnapshot();
}
