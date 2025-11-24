import { describe, expect, test } from "bun:test";
import { write_todos } from "../../tools/impl/WriteTodosGemini";

describe("WriteTodos tool (Gemini)", () => {
  test("accepts valid todos", async () => {
    const result = await write_todos({
      todos: [
        { description: "Task 1", status: "pending" },
        { description: "Task 2", status: "in_progress" },
        { description: "Task 3", status: "completed" },
      ],
    });

    expect(result.message).toBeTruthy();
  });

  test("handles todos with cancelled status", async () => {
    const result = await write_todos({
      todos: [
        { description: "Task 1", status: "pending" },
        { description: "Task 2", status: "cancelled" },
      ],
    });

    expect(result.message).toBeTruthy();
  });

  test("validates todos is an array", async () => {
    await expect(
      write_todos({
        todos: "not an array" as unknown,
      } as Parameters<typeof write_todos>[0]),
    ).rejects.toThrow(/array/);
  });

  test("validates each todo has description", async () => {
    await expect(
      write_todos({
        todos: [{ status: "pending" }],
      } as Parameters<typeof write_todos>[0]),
    ).rejects.toThrow(/description/);
  });

  test("validates each todo has valid status", async () => {
    await expect(
      write_todos({
        todos: [{ description: "Task", status: "invalid" as unknown }],
      } as Parameters<typeof write_todos>[0]),
    ).rejects.toThrow(/status/);
  });

  test("throws error when todos is missing", async () => {
    await expect(
      write_todos({} as Parameters<typeof write_todos>[0]),
    ).rejects.toThrow(/todos/);
  });
});
