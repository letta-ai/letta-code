import { describe, expect, test } from "bun:test";
import { todo_write } from "../../tools/impl/TodoWrite";

describe("TodoWrite tool", () => {
  test("accepts valid todos with all required fields", async () => {
    const result = await todo_write({
      todos: [
        {
          content: "Run tests",
          status: "pending",
          activeForm: "Running tests",
        },
        { content: "Fix bug", status: "in_progress", activeForm: "Fixing bug" },
      ],
    });

    expect(result.message).toBeDefined();
    expect(result.message).toContain("modified successfully");
  });

  test("requires activeForm field", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid input
          { content: "Missing activeForm", status: "pending" },
        ],
      }),
    ).rejects.toThrow(/activeForm string/);
  });

  test("requires content field", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid input
          { activeForm: "Testing", status: "pending" },
        ],
      }),
    ).rejects.toThrow(/content string/);
  });

  test("requires status field", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid input
          { content: "Test", activeForm: "Testing" },
        ],
      }),
    ).rejects.toThrow(/valid status/);
  });

  test("validates status values", async () => {
    await expect(
      todo_write({
        todos: [
          // @ts-expect-error - testing invalid status
          { content: "Test", status: "invalid", activeForm: "Testing" },
        ],
      }),
    ).rejects.toThrow(/valid status/);
  });

  test("handles empty todo list", async () => {
    const result = await todo_write({ todos: [] });

    expect(result.message).toBeDefined();
  });
});
