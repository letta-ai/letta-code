import { describe, expect, test } from "bun:test";
import { type Line, linesToMarkdown } from "@/cli/helpers/accumulator";

describe("linesToMarkdown", () => {
  test("renders user and assistant turns with role headers", () => {
    const lines: Line[] = [
      { kind: "user", id: "u1", text: "Hello there" },
      {
        kind: "assistant",
        id: "a1",
        text: "Hi! How can I help?",
        phase: "finished",
      },
    ];
    expect(linesToMarkdown(lines)).toBe(
      "## User\n\nHello there\n\n## Assistant\n\nHi! How can I help?",
    );
  });

  test("returns an empty string for an empty or content-free conversation", () => {
    expect(linesToMarkdown([])).toBe("");
    expect(
      linesToMarkdown([
        { kind: "separator", id: "s1" },
        { kind: "status", id: "st1", lines: ["working..."] },
      ]),
    ).toBe("");
  });

  test("excludes reasoning by default and includes it when requested", () => {
    const lines: Line[] = [
      { kind: "reasoning", id: "r1", text: "thinking hard", phase: "finished" },
      { kind: "assistant", id: "a1", text: "Done", phase: "finished" },
    ];
    expect(linesToMarkdown(lines)).toBe("## Assistant\n\nDone");
    expect(linesToMarkdown(lines, { includeReasoning: true })).toBe(
      "### Reasoning\n\nthinking hard\n\n## Assistant\n\nDone",
    );
  });

  test("renders tool calls with pretty-printed JSON args and a result block", () => {
    const lines: Line[] = [
      {
        kind: "tool_call",
        id: "t1",
        name: "bash",
        argsText: '{"command":"ls"}',
        resultText: "file.txt",
        resultOk: true,
        phase: "finished",
      },
    ];
    const md = linesToMarkdown(lines);
    expect(md).toContain("### Tool: `bash`");
    expect(md).toContain('```json\n{\n  "command": "ls"\n}\n```');
    expect(md).toContain("<details>\n<summary>Result</summary>");
    expect(md).toContain("```\nfile.txt\n```");
  });

  test("labels failed tool results as errors", () => {
    const lines: Line[] = [
      {
        kind: "tool_call",
        id: "t1",
        name: "bash",
        argsText: "{}",
        resultText: "boom",
        resultOk: false,
        phase: "finished",
      },
    ];
    expect(linesToMarkdown(lines)).toContain(
      "<summary>Result (error)</summary>",
    );
  });

  test("keeps non-JSON tool args as raw text without a language hint", () => {
    const lines: Line[] = [
      {
        kind: "tool_call",
        id: "t1",
        name: "shell",
        argsText: "not json",
        phase: "finished",
      },
    ];
    const md = linesToMarkdown(lines);
    expect(md).toContain("### Tool: `shell`");
    expect(md).toContain("```\nnot json\n```");
  });

  test("can omit tool calls entirely", () => {
    const lines: Line[] = [
      { kind: "user", id: "u1", text: "run it" },
      {
        kind: "tool_call",
        id: "t1",
        name: "bash",
        argsText: "{}",
        phase: "finished",
      },
    ];
    expect(linesToMarkdown(lines, { includeToolCalls: false })).toBe(
      "## User\n\nrun it",
    );
  });

  test("escapes code fences when content contains backticks", () => {
    const lines: Line[] = [
      {
        kind: "tool_call",
        id: "t1",
        name: "shell",
        argsText: "echo ```nested```",
        phase: "finished",
      },
    ];
    const md = linesToMarkdown(lines);
    // A run of 3 backticks in the content forces a 4-backtick fence.
    expect(md).toContain("````\necho ```nested```\n````");
  });

  test("merges streaming continuation lines into a single assistant section", () => {
    const lines: Line[] = [
      {
        kind: "assistant",
        id: "a1",
        text: "First paragraph.\n\n",
        phase: "finished",
      },
      {
        kind: "assistant",
        id: "a1-split-0",
        text: "Second paragraph.",
        phase: "finished",
        isContinuation: true,
      },
    ];
    expect(linesToMarkdown(lines)).toBe(
      "## Assistant\n\nFirst paragraph.\n\nSecond paragraph.",
    );
    // A single merged section means exactly one assistant header.
    expect(linesToMarkdown(lines).match(/## Assistant/g)?.length).toBe(1);
  });

  test("renders errors and skips non-conversation line kinds", () => {
    const lines: Line[] = [
      { kind: "user", id: "u1", text: "hi" },
      { kind: "command", id: "c1", input: "/help", output: "..." },
      { kind: "error", id: "e1", text: "Something failed" },
    ];
    expect(linesToMarkdown(lines)).toBe(
      "## User\n\nhi\n\n## Error\n\nSomething failed",
    );
  });
});
