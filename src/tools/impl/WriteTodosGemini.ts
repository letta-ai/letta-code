/**
 * Gemini CLI write_todos tool - adapter for Letta Code's todo_write
 * Uses Gemini's exact schema and description but adapts the params
 */

interface WriteTodosGeminiArgs {
  todos: Array<{
    description: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
}

export async function write_todos(
  args: WriteTodosGeminiArgs,
): Promise<{ message: string; todos: typeof args.todos }> {
  // Gemini uses "description" field, Letta Code uses "content" field
  // Convert to Letta format and validate
  if (!Array.isArray(args.todos)) {
    throw new Error("todos must be an array");
  }

  for (const todo of args.todos) {
    if (!todo.description || typeof todo.description !== "string") {
      throw new Error("Each todo must have a description string");
    }
    if (
      !todo.status ||
      !["pending", "in_progress", "completed", "cancelled"].includes(
        todo.status,
      )
    ) {
      throw new Error(
        "Each todo must have a valid status (pending, in_progress, completed, or cancelled)",
      );
    }
  }

  // Validate only one in_progress
  const inProgressCount = args.todos.filter(
    (t) => t.status === "in_progress",
  ).length;
  if (inProgressCount > 1) {
    throw new Error("Only one task can be 'in_progress' at a time.");
  }

  const todoListString = args.todos
    .map((todo, index) => `${index + 1}. [${todo.status}] ${todo.description}`)
    .join("\n");

  const message =
    args.todos.length > 0
      ? `Successfully updated the todo list. The current list is now:\n${todoListString}`
      : "Successfully cleared the todo list.";

  // Return with both message and todos for UI rendering
  return {
    message,
    todos: args.todos,
  };
}
