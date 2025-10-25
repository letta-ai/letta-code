import { describe, expect, test } from "bun:test";
import { todo_write } from "../../tools/impl/TodoWrite";

describe("TodoWrite tool", () => {
  test("accepts valid todos with all required fields", async () => {
    const result = await todo_write({
      todos: [
        { id: "1", content: "Task 1", status: "pending" },
        { id: "2", content: "Task 2", status: "in_progress" },
      ],
    });

    expect(result.message).toBeDefined();
    expect(result.message).toContain("modified successfully");
  });

  test("requires id field", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid input
          { content: "Missing id", status: "pending" },
        ],
      }),
    ).rejects.toThrow(/id string/);
  });

  test("requires content field", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid input
          { id: "1", status: "pending" },
        ],
      }),
    ).rejects.toThrow(/content string/);
  });

  test("requires status field", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid input
          { id: "1", content: "Test" },
        ],
      }),
    ).rejects.toThrow(/valid status/);
  });

  test("validates status values", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid status
          { id: "1", content: "Test", status: "invalid" },
        ],
      }),
    ).rejects.toThrow(/valid status/);
  });

  test("handles empty todo list", async () => {
    const result = await todo_write({ todos: [] });

    expect(result.message).toBeDefined();
  });

  test("accepts optional priority field", async () => {
    const result = await todo_write({
      todos: [
        {
          id: "1",
          content: "High priority task",
          status: "pending",
          priority: "high",
        },
        {
          id: "2",
          content: "Low priority task",
          status: "pending",
          priority: "low",
        },
      ],
    });

    expect(result.message).toContain("modified successfully");
  });

  test("validates priority values", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid priority
          { id: "1", content: "Test", status: "pending", priority: "urgent" },
        ],
      }),
    ).rejects.toThrow(/priority must be/);
  });
});
