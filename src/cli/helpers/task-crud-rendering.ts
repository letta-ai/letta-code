import { listTasks, type TaskStoreScope } from "@/tools/impl/tasks/store.js";

export interface TaskCrudTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  id: string;
}

export function taskCrudTodos(scope: TaskStoreScope): TaskCrudTodo[] {
  return listTasks(scope).map((task) => ({
    content: task.subject,
    status: task.status === "deleted" ? "completed" : task.status,
    id: task.taskId,
  }));
}
