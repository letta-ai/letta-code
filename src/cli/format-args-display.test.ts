import { describe, expect, test } from "bun:test";
import { formatArgsDisplay } from "@/cli/helpers/format-args-display";

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
      "src/cli/helpers/formatArgsDisplay.ts, lines: 1-80",
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

  test("uses cmd for Codex unified exec shell display", () => {
    const args = JSON.stringify({
      cmd: "git status --short",
    });

    const formatted = formatArgsDisplay(args, "exec_command");
    expect(formatted.display).toBe("git status --short");
    expect(formatted.shellSemantic).toMatchObject({
      kind: "run",
      label: "Run",
      rawCommand: "git status --short",
    });
  });

  test("uses Codex unified exec description when present", () => {
    const args = JSON.stringify({
      cmd: "git status --short",
      description: "Show working tree status",
    });

    const formatted = formatArgsDisplay(args, "exec_command");
    expect(formatted.display).toBe("Show working tree status");
    expect(formatted.shellSemantic).toMatchObject({
      kind: "run",
      label: "Run",
      rawCommand: "git status --short",
    });
  });

  test("uses Gemini shell description when present", () => {
    const args = JSON.stringify({
      command: "git status --short",
      description: "Show working tree status",
    });

    const formatted = formatArgsDisplay(args, "RunShellCommand");
    expect(formatted.display).toBe("Show working tree status");
    expect(formatted.shellSemantic).toMatchObject({
      kind: "run",
      label: "Run",
      rawCommand: "git status --short",
    });
  });

  test("summarizes Codex write_stdin without raw polling args", () => {
    const args = JSON.stringify({
      session_id: 8,
      chars: "hello from stdin\n",
      yield_time_ms: 1000,
      max_output_tokens: 2000,
    });

    const formatted = formatArgsDisplay(args, "write_stdin");
    expect(formatted.displayName).toBe("Interacted with background terminal");
    expect(formatted.display).toBe("(session 8)");
    expect(formatted.shellSemantic).toBeUndefined();
  });

  test("summarizes Codex write_stdin with original command display when available", () => {
    const args = JSON.stringify({
      session_id: 8,
      chars: "hello from stdin\n",
      yield_time_ms: 1000,
      max_output_tokens: 2000,
    });

    const formatted = formatArgsDisplay(args, "write_stdin", {
      unifiedExecCommandDisplay: "python3 repl.py",
    });
    expect(formatted.displayName).toBe("Interacted with background terminal");
    expect(formatted.display).toBe("· python3 repl.py");
    expect(formatted.shellSemantic).toBeUndefined();
  });

  test("summarizes Codex write_stdin polling as a background terminal check", () => {
    const args = JSON.stringify({
      session_id: 8,
      yield_time_ms: 1000,
      max_output_tokens: 2000,
    });

    const formatted = formatArgsDisplay(args, "write_stdin");
    expect(formatted.displayName).toBe("Checked background terminal");
    expect(formatted.display).toBe("(session 8)");
    expect(formatted.shellSemantic).toBeUndefined();
  });

  test("does not label failed write_stdin as a terminal interaction", () => {
    const args = JSON.stringify({
      session_id: 8,
      chars: "hello from stdin\n",
    });

    const formatted = formatArgsDisplay(args, "write_stdin", {
      unifiedExecCommandDisplay: "cat",
      suppressUnifiedExecInteractionLabel: true,
    });
    expect(formatted.displayName).toBeUndefined();
    expect(formatted.display).toBe("· cat");
  });
});
