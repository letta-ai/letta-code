import { describe, expect, test } from "bun:test";
import { formatArgsDisplay } from "../../cli/helpers/formatArgsDisplay";

describe("formatArgsDisplay compact plan/todo headers", () => {
  test("shows only plan item count for update_plan", () => {
    const args = JSON.stringify({
      explanation: "Investigating restart regression",
      plan: [
        { step: "Step 1", status: "pending" },
        { step: "Step 2", status: "pending" },
        { step: "Step 3", status: "pending" },
      ],
    });

    expect(formatArgsDisplay(args, "update_plan").display).toBe("3 items");
  });

  test("handles singular plan item count for UpdatePlan", () => {
    const args = JSON.stringify({
      explanation: "One-step fix",
      plan: [{ step: "Step 1", status: "pending" }],
    });

    expect(formatArgsDisplay(args, "UpdatePlan").display).toBe("1 item");
  });

  test("shows only todo item count for TODO tools", () => {
    const args = JSON.stringify({
      todos: [
        { content: "First", status: "pending" },
        { content: "Second", status: "in_progress" },
      ],
      note: "extra metadata",
    });

    expect(formatArgsDisplay(args, "TodoWrite").display).toBe("2 items");
    expect(formatArgsDisplay(args, "write_todos").display).toBe("2 items");
  });

  test("uses semantic summaries for read-only shell commands", () => {
    const args = JSON.stringify({
      command: "sed -n '1,80p' src/cli/helpers/formatArgsDisplay.ts",
    });

    const formatted = formatArgsDisplay(args, "Bash");
    expect(formatted.display).toBe(
      "path: src/cli/helpers/formatArgsDisplay.ts, lines: 1-80",
    );
    expect(formatted.shellSemantic).toMatchObject({
      kind: "read",
      label: "Read",
    });
  });

  test("keeps generic shell commands on the run path", () => {
    const args = JSON.stringify({
      command: "git status --short",
    });

    const formatted = formatArgsDisplay(args, "Bash");
    expect(formatted.display).toBe("git status --short");
    expect(formatted.shellSemantic).toMatchObject({
      kind: "run",
      label: "Run",
      rawCommand: "git status --short",
    });
  });
});
