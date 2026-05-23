import { validateRequiredParams } from "./validation.js";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}
interface TodoWriteArgs {
  todos: TodoItem[];
}
interface TodoWriteResult {
  message: string;
}

export async function todo_write(
  args: TodoWriteArgs,
): Promise<TodoWriteResult> {
  validateRequiredParams(args, ["todos"], "TodoWrite");
  if (!args.todos || !Array.isArray(args.todos))
    throw new Error("todos must be an array");
  for (const todo of args.todos) {
    if (!todo.content || typeof todo.content !== "string")
      throw new Error("Each todo must have a content string");
    if (
      !todo.status ||
      !["pending", "in_progress", "completed"].includes(todo.status)
    )
      throw new Error(
        "Each todo must have a valid status (pending, in_progress, or completed)",
      );
    if (!todo.activeForm || typeof todo.activeForm !== "string")
      throw new Error("Each todo must have an activeForm string");
  }
  return {
    message:
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
  };
}
