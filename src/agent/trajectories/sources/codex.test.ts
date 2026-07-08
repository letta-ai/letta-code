import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexSource } from "./codex";

const SESSION_ID = "2026-07-04T09-00-00-abc12345";

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function rolloutJsonl(): string {
  return (
    line({
      type: "session_meta",
      timestamp: "2026-07-04T09:00:00.000Z",
      payload: {
        id: "abc12345",
        timestamp: "2026-07-04T09:00:00.000Z",
        cwd: "/repo/codex",
        git: { branch: "dev" },
      },
    }) +
    line({
      type: "turn_context",
      timestamp: "2026-07-04T09:00:00.500Z",
      payload: { cwd: "/repo/codex", model: "gpt-5-codex" },
    }) +
    // System-prompt-class injections riding on user-role response items.
    line({
      type: "response_item",
      timestamp: "2026-07-04T09:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<environment_context>\n<cwd>/repo/codex</cwd>\n</environment_context>",
          },
        ],
      },
    }) +
    line({
      type: "response_item",
      timestamp: "2026-07-04T09:00:01.100Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<user_instructions>be terse</user_instructions>",
          },
        ],
      },
    }) +
    line({
      type: "response_item",
      timestamp: "2026-07-04T09:00:02.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Add a test" }],
      },
    }) +
    // event_msg user_message duplicates the response item → dropped.
    line({
      type: "event_msg",
      timestamp: "2026-07-04T09:00:02.100Z",
      payload: { type: "user_message", message: "Add a test" },
    }) +
    line({
      type: "event_msg",
      timestamp: "2026-07-04T09:00:03.000Z",
      payload: { type: "agent_reasoning", text: "Let me look." },
    }) +
    line({
      type: "response_item",
      timestamp: "2026-07-04T09:00:04.000Z",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "call_1",
        arguments: '{"command":["ls"]}',
      },
    }) +
    line({
      type: "response_item",
      timestamp: "2026-07-04T09:00:05.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call_1",
        output: "README.md",
      },
    }) +
    // Developer-role messages are the agent's instruction surface → dropped.
    line({
      type: "response_item",
      timestamp: "2026-07-04T09:00:05.500Z",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "internal instructions" }],
      },
    }) +
    line({
      type: "response_item",
      timestamp: "2026-07-04T09:00:06.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    })
  );
}

describe("createCodexSource", () => {
  let store: string;
  let dayDir: string;
  let sessionPath: string;

  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), "codex-store-"));
    dayDir = join(store, "2026", "07", "04");
    mkdirSync(dayDir, { recursive: true });
    sessionPath = join(dayDir, `rollout-${SESSION_ID}.jsonl`);
    writeFileSync(sessionPath, rolloutJsonl());
  });

  afterEach(() => {
    rmSync(store, { recursive: true, force: true });
  });

  test("discovers rollouts recursively from the dated store", async () => {
    const sessions = await createCodexSource(store).discover();
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session?.harness).toBe("codex");
    expect(session?.sessionId).toBe(SESSION_ID);
    expect(session?.path).toBe(sessionPath);
    expect(session?.cwd).toBe("/repo/codex");
    // user, reasoning, tool_use, tool, assistant
    expect(session?.recordCount).toBe(5);
    expect(session?.startTime).toBe("2026-07-04T09:00:02.000Z");
    expect(session?.endTime).toBe("2026-07-04T09:00:06.000Z");
  });

  test("resolves session-id prefix, file, and dir locators", async () => {
    const source = createCodexSource(store);
    const byPrefix = await source.discover("2026-07-04T09-00-00");
    expect(byPrefix.map((s) => s.sessionId)).toEqual([SESSION_ID]);
    const byFile = await source.discover(sessionPath);
    expect(byFile).toHaveLength(1);
    const byDir = await source.discover(dayDir);
    expect(byDir).toHaveLength(1);
    await expect(source.discover("nope")).rejects.toThrow(
      'No Codex session matches "nope"',
    );
  });

  test("normalizes to v1 records with injected blocks dropped", async () => {
    const source = createCodexSource(store);
    const sessions = await source.discover();
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);

    expect(records).toEqual([
      {
        role: "meta",
        source: "codex",
        cwd: "/repo/codex",
        git_branch: "dev",
        model: "gpt-5-codex",
      },
      {
        role: "user",
        content: "Add a test",
        timestamp: "2026-07-04T09:00:02.000Z",
      },
      {
        role: "reasoning",
        content: "Let me look.",
        timestamp: "2026-07-04T09:00:03.000Z",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", name: "shell", args: '{"command":["ls"]}' },
        ],
        timestamp: "2026-07-04T09:00:04.000Z",
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "README.md",
        timestamp: "2026-07-04T09:00:05.000Z",
      },
      {
        role: "assistant",
        content: "Done.",
        timestamp: "2026-07-04T09:00:06.000Z",
      },
    ]);
    const dump = JSON.stringify(records);
    expect(dump).not.toContain("environment_context");
    expect(dump).not.toContain("user_instructions");
    expect(dump).not.toContain("internal instructions");
  });

  test("handles custom tool calls and structured outputs", async () => {
    writeFileSync(
      sessionPath,
      line({
        type: "response_item",
        timestamp: "2026-07-05T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "patch it" }],
        },
      }) +
        line({
          type: "response_item",
          timestamp: "2026-07-05T10:00:01.000Z",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            call_id: "call_9",
            input: "*** Begin Patch",
          },
        }) +
        line({
          type: "response_item",
          timestamp: "2026-07-05T10:00:02.000Z",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_9",
            output: { content: "Applied.", success: true },
          },
        }) +
        line({
          type: "response_item",
          timestamp: "2026-07-05T10:00:03.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Patched." }],
          },
        }),
    );
    const source = createCodexSource(store);
    const sessions = await source.discover();
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);

    const call = records.find((r) => r.tool_calls)?.tool_calls?.[0];
    expect(call).toEqual({
      id: "call_9",
      name: "apply_patch",
      args: '{"input":"*** Begin Patch"}',
    });
    const toolRecord = records.find((r) => r.role === "tool");
    expect(toolRecord?.content).toBe("Applied.");
  });

  test("skips invalid and conversation-less rollouts instead of throwing", async () => {
    writeFileSync(join(dayDir, "rollout-empty.jsonl"), "");
    writeFileSync(join(dayDir, "rollout-garbage.jsonl"), "{{{not json\n");
    // No assistant records → skipped.
    writeFileSync(
      join(dayDir, "rollout-user-only.jsonl"),
      line({
        type: "response_item",
        timestamp: "2026-07-04T11:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "anyone there?" }],
        },
      }),
    );
    const sessions = await createCodexSource(store).discover();
    expect(sessions.map((s) => s.sessionId)).toEqual([SESSION_ID]);
  });
});
