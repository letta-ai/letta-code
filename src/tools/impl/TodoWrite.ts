interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  id: string;
  priority?: "high" | "medium" | "low";
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
    if (!todo.id || typeof todo.id !== "string")
      throw new Error("Each todo must have an id string");
    if (todo.priority && !["high", "medium", "low"].includes(todo.priority))
      throw new Error("If provided, priority must be high, medium, or low");
  }
  return {
    message:
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
  };
}
