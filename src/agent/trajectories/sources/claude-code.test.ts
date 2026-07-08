import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCodeSource } from "./claude-code";

const SESSION_ID = "aaaa1111-2222-3333-4444-555566667777";

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

/** A representative session: user prompt, injected noise, assistant
 * text + tool_use, tool_result, plus transport/sidechain records. */
function sessionJsonl(): string {
  return (
    line({
      type: "user",
      timestamp: "2026-07-01T10:00:00.000Z",
      cwd: "/repo/app",
      gitBranch: "main",
      message: { role: "user", content: "Fix the bug" },
    }) +
    line({
      type: "user",
      timestamp: "2026-07-01T10:00:01.000Z",
      message: {
        role: "user",
        content: "<command-name>/clear</command-name>",
      },
    }) +
    line({
      type: "progress",
      timestamp: "2026-07-01T10:00:02.000Z",
      data: { text: "subagent transcript goes here" },
    }) +
    line({
      type: "assistant",
      isSidechain: true,
      timestamp: "2026-07-01T10:00:03.000Z",
      message: {
        model: "claude-haiku-4",
        content: [{ type: "text", text: "sidechain chatter" }],
      },
    }) +
    line({
      type: "assistant",
      timestamp: "2026-07-01T10:00:10.000Z",
      message: {
        model: "claude-opus-4",
        content: [
          { type: "text", text: "Looking." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    }) +
    line({
      type: "user",
      timestamp: "2026-07-01T10:00:20.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "file.txt" }],
          },
        ],
      },
    })
  );
}

describe("createClaudeCodeSource", () => {
  let store: string;
  let projectDir: string;
  let sessionPath: string;

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), "cc-store-"));
    projectDir = join(store, "-Users-me-repo-app");
    mkdirSync(projectDir, { recursive: true });
    sessionPath = join(projectDir, `${SESSION_ID}.jsonl`);
    writeFileSync(sessionPath, sessionJsonl());
  });

  afterEach(() => {
    rmSync(store, { recursive: true, force: true });
  });

  test("discovers sessions from the store with metadata", async () => {
    const sessions = await createClaudeCodeSource(store).discover();
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session?.harness).toBe("claude");
    expect(session?.sessionId).toBe(SESSION_ID);
    expect(session?.path).toBe(sessionPath);
    expect(session?.cwd).toBe("/repo/app");
    expect(session?.recordCount).toBe(4); // user, assistant, tool_use, tool
    expect(session?.startTime).toBe("2026-07-01T10:00:00.000Z");
    expect(session?.endTime).toBe("2026-07-01T10:00:20.000Z");
    expect(session?.estTokens).toBeGreaterThan(0);
  });

  test("resolves a session-id prefix locator", async () => {
    const source = createClaudeCodeSource(store);
    const byPrefix = await source.discover("aaaa1111");
    expect(byPrefix.map((s) => s.sessionId)).toEqual([SESSION_ID]);
    const byExact = await source.discover(SESSION_ID);
    expect(byExact.map((s) => s.sessionId)).toEqual([SESSION_ID]);
    await expect(source.discover("zzzz")).rejects.toThrow(
      'No Claude Code session matches "zzzz"',
    );
  });

  test("resolves explicit file and project-dir locators", async () => {
    const source = createClaudeCodeSource(store);
    const byFile = await source.discover(sessionPath);
    expect(byFile.map((s) => s.sessionId)).toEqual([SESSION_ID]);
    const byDir = await source.discover(projectDir);
    expect(byDir.map((s) => s.sessionId)).toEqual([SESSION_ID]);
  });

  test("normalizes to v1 records: meta first, noise dropped, calls linked", async () => {
    const source = createClaudeCodeSource(store);
    const sessions = await source.discover();
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);

    expect(records).toEqual([
      {
        role: "meta",
        source: "claude_code",
        cwd: "/repo/app",
        git_branch: "main",
        model: "claude-opus-4",
      },
      {
        role: "user",
        content: "Fix the bug",
        timestamp: "2026-07-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Looking.",
        timestamp: "2026-07-01T10:00:10.000Z",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "toolu_1", name: "Bash", args: '{"command":"ls"}' }],
        timestamp: "2026-07-01T10:00:10.000Z",
      },
      {
        role: "tool",
        tool_call_id: "toolu_1",
        content: "file.txt",
        timestamp: "2026-07-01T10:00:20.000Z",
      },
    ]);
    // Noise and sidechain content must not survive anywhere.
    const dump = JSON.stringify(records);
    expect(dump).not.toContain("<command-name>");
    expect(dump).not.toContain("sidechain chatter");
    expect(dump).not.toContain("subagent transcript");
  });

  test("truncates long tool results and reshapes oversized args", async () => {
    const longResult = "x".repeat(3000);
    const bigInput = "y".repeat(25_000);
    writeFileSync(
      sessionPath,
      line({
        type: "user",
        timestamp: "2026-07-02T08:00:00.000Z",
        message: { role: "user", content: "go" },
      }) +
        line({
          type: "assistant",
          timestamp: "2026-07-02T08:00:05.000Z",
          message: {
            model: "claude-opus-4",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Write",
                input: { data: bigInput },
              },
            ],
          },
        }) +
        line({
          type: "user",
          timestamp: "2026-07-02T08:00:10.000Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: longResult },
            ],
          },
        }),
    );
    const source = createClaudeCodeSource(store);
    const sessions = await source.discover();
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);

    const toolRecord = records.find((r) => r.role === "tool");
    expect(toolRecord?.content).toBe(
      `${"x".repeat(2500)}\n… [truncated, 500 more chars]`,
    );

    const callRecord = records.find((r) => r.tool_calls);
    const args = callRecord?.tool_calls?.[0]?.args ?? "";
    expect(args.length).toBeLessThanOrEqual(20_000);
    const parsedArgs = JSON.parse(args) as { data: string };
    expect(parsedArgs.data).toContain("… [truncated,");
    expect(parsedArgs.data.length).toBeLessThan(25_000);
  });

  test("skips empty, invalid, and conversation-less files instead of throwing", async () => {
    writeFileSync(join(projectDir, "empty.jsonl"), "");
    writeFileSync(join(projectDir, "garbage.jsonl"), "not json at all\n{{{\n");
    // Only user records → skipped (no assistant records).
    writeFileSync(
      join(projectDir, "user-only.jsonl"),
      line({
        type: "user",
        timestamp: "2026-07-01T11:00:00.000Z",
        message: { role: "user", content: "hello?" },
      }),
    );
    const sessions = await createClaudeCodeSource(store).discover();
    expect(sessions.map((s) => s.sessionId)).toEqual([SESSION_ID]);
  });

  test("synthesizes timestamps when the source recorded none", async () => {
    writeFileSync(
      sessionPath,
      line({ type: "user", message: { role: "user", content: "hi" } }) +
        line({
          type: "assistant",
          message: {
            model: "claude-opus-4",
            content: [{ type: "text", text: "hello" }],
          },
        }),
    );
    const source = createClaudeCodeSource(store);
    const sessions = await source.discover();
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);
    const body = records.filter((r) => r.role !== "meta");
    for (const record of body) {
      expect(record.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
    const first = body[0]?.timestamp ?? "";
    const second = body[1]?.timestamp ?? "";
    expect(first < second).toBe(true);
  });
});
