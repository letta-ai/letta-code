import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenHandsSource } from "./openhands";

const USER_MESSAGE_EVENT = {
  kind: "MessageEvent",
  id: "evt-user-1",
  timestamp: "2026-07-04T09:15:23.123456",
  source: "user",
  llm_message: {
    role: "user",
    content: [{ type: "text", text: "Fix the failing test" }],
  },
};

const AGENT_MESSAGE_EVENT = {
  kind: "MessageEvent",
  id: "evt-agent-1",
  timestamp: "2026-07-04T09:16:00.000000",
  source: "agent",
  llm_message: {
    role: "assistant",
    content: [
      { type: "text", text: "Done — the test " },
      { type: "text", text: "passes now." },
    ],
  },
};

const ACTION_EVENT = {
  kind: "ActionEvent",
  id: "evt-action-1",
  timestamp: "2026-07-04T09:15:30.001122",
  source: "agent",
  thought: [{ type: "text", text: "I'll run the tests first." }],
  tool_name: "terminal",
  tool_call_id: "toolu_01ABC",
  tool_call: {
    id: "toolu_01ABC",
    name: "terminal",
    arguments: '{"command": "bun test"}',
  },
  action: { kind: "TerminalAction", command: "bun test" },
};

const OBSERVATION_EVENT = {
  kind: "ObservationEvent",
  id: "evt-obs-1",
  timestamp: "2026-07-04T09:15:35.445566",
  source: "environment",
  tool_name: "terminal",
  tool_call_id: "toolu_01ABC",
  action_id: "evt-action-1",
  observation: {
    kind: "TerminalObservation",
    content: [{ type: "text", text: "1 pass, 0 fail" }],
    is_error: false,
  },
};

const SYSTEM_PROMPT_EVENT = {
  kind: "SystemPromptEvent",
  id: "evt-sys-1",
  source: "agent",
};

const ALL_EVENTS = [
  SYSTEM_PROMPT_EVENT,
  USER_MESSAGE_EVENT,
  ACTION_EVENT,
  OBSERVATION_EVENT,
  AGENT_MESSAGE_EVENT,
];

function writeEvents(convDir: string, events: unknown[]): string {
  const eventsDir = join(convDir, "events");
  mkdirSync(eventsDir, { recursive: true });
  for (const [i, event] of events.entries()) {
    const id = (event as { id: string }).id;
    writeFileSync(
      join(eventsDir, `event-${String(i).padStart(5, "0")}-${id}.json`),
      JSON.stringify(event),
    );
  }
  return eventsDir;
}

describe("createOpenHandsSource", () => {
  const source = createOpenHandsSource();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oh-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("requires a locator", async () => {
    await expect(source.discover()).rejects.toThrow("no default local store");
  });

  test("throws on a missing path or an event-less directory", async () => {
    await expect(source.discover(join(dir, "nope"))).rejects.toThrow(
      "No such OpenHands session path",
    );
    await expect(source.discover(dir)).rejects.toThrow(
      "No OpenHands event files",
    );
  });

  test("discovers a conversation directory (events/ subdir)", async () => {
    const convDir = join(dir, "conv-abc");
    writeEvents(convDir, ALL_EVENTS);
    const sessions = await source.discover(convDir);
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session?.harness).toBe("openhands");
    expect(session?.sessionId).toBe("conv-abc");
    // user, reasoning, tool_use, tool, assistant
    expect(session?.recordCount).toBe(5);
    expect(session?.startTime).toBe("2026-07-04T09:15:23.123Z");
    expect(session?.endTime).toBe("2026-07-04T09:16:00.000Z");
  });

  test("accepts the events/ directory itself, naming the conversation", async () => {
    const convDir = join(dir, "conv-xyz");
    const eventsDir = writeEvents(convDir, ALL_EVENTS);
    const sessions = await source.discover(eventsDir);
    expect(sessions.map((s) => s.sessionId)).toEqual(["conv-xyz"]);
  });

  test("discovers every conversation under a store directory", async () => {
    writeEvents(join(dir, "conv-a"), ALL_EVENTS);
    writeEvents(join(dir, "conv-b"), [USER_MESSAGE_EVENT, AGENT_MESSAGE_EVENT]);
    // A conversation whose events are unusable must be skipped, not thrown.
    const badDir = join(dir, "conv-bad", "events");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "event-00000-x.json"), "not json");
    const sessions = await source.discover(dir);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual([
      "conv-a",
      "conv-b",
    ]);
  });

  test("reads a single JSON file with the {items: [...]} envelope", async () => {
    const file = join(dir, "conv-file.json");
    writeFileSync(file, JSON.stringify({ items: ALL_EVENTS }));
    const sessions = await source.discover(file);
    expect(sessions.map((s) => s.sessionId)).toEqual(["conv-file"]);
  });

  test("normalizes to v1 records: thought → reasoning, calls linked", async () => {
    const convDir = join(dir, "conv-abc");
    writeEvents(convDir, ALL_EVENTS);
    const sessions = await source.discover(convDir);
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);

    expect(records).toEqual([
      { role: "meta", source: "openhands" },
      {
        role: "user",
        content: "Fix the failing test",
        source_id: "evt-user-1",
        timestamp: "2026-07-04T09:15:23.123Z",
      },
      {
        role: "reasoning",
        content: "I'll run the tests first.",
        source_id: "evt-action-1:thought",
        timestamp: "2026-07-04T09:15:30.001Z",
      },
      {
        role: "assistant",
        content: null,
        source_id: "evt-action-1",
        tool_calls: [
          {
            id: "toolu_01ABC",
            name: "terminal",
            args: '{"command": "bun test"}',
          },
        ],
        timestamp: "2026-07-04T09:15:30.001Z",
      },
      {
        role: "tool",
        tool_call_id: "toolu_01ABC",
        content: "1 pass, 0 fail",
        source_id: "evt-obs-1",
        timestamp: "2026-07-04T09:15:35.445Z",
      },
      {
        role: "assistant",
        content: "Done — the test passes now.",
        source_id: "evt-agent-1",
        timestamp: "2026-07-04T09:16:00.000Z",
      },
    ]);
  });

  test("maps agent errors and rejections to tool results", async () => {
    const convDir = join(dir, "conv-err");
    writeEvents(convDir, [
      USER_MESSAGE_EVENT,
      { ...ACTION_EVENT, thought: [] },
      {
        kind: "AgentErrorEvent",
        id: "evt-err-1",
        timestamp: "2026-07-04T09:15:36.000000",
        source: "agent",
        tool_call_id: "toolu_01ABC",
        action_id: "evt-action-1",
        error: "command not found",
      },
      AGENT_MESSAGE_EVENT,
    ]);
    const sessions = await source.discover(convDir);
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);
    const toolRecord = records.find((r) => r.role === "tool");
    expect(toolRecord?.tool_call_id).toBe("toolu_01ABC");
    expect(toolRecord?.content).toBe("command not found");
    // Empty thought → no reasoning record.
    expect(records.some((r) => r.role === "reasoning")).toBe(false);
  });

  test("links observations by action_id when tool_call_id is absent", async () => {
    const convDir = join(dir, "conv-actionid");
    const action = {
      ...ACTION_EVENT,
      tool_call_id: undefined,
      tool_call: null,
    };
    const observation = { ...OBSERVATION_EVENT, tool_call_id: undefined };
    writeEvents(convDir, [
      USER_MESSAGE_EVENT,
      action,
      observation,
      AGENT_MESSAGE_EVENT,
    ]);
    const sessions = await source.discover(convDir);
    const session = sessions[0];
    if (!session) throw new Error("expected a session");
    const { records } = await source.normalize(session);
    const call = records.find((r) => r.tool_calls)?.tool_calls?.[0];
    const toolRecord = records.find((r) => r.role === "tool");
    expect(call?.id).toBe("oh_evt-action-1");
    // Args fall back to the action payload (kind stripped).
    expect(call?.args).toBe('{"command":"bun test"}');
    expect(toolRecord?.tool_call_id).toBe("oh_evt-action-1");
    expect(toolRecord?.content).toBe("1 pass, 0 fail");
  });
});
