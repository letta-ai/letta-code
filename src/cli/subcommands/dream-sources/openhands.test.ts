import { describe, expect, test } from "bun:test";
import { convertOpenHandsEvents } from "./openhands";

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

describe("convertOpenHandsEvents", () => {
  test("converts user and agent messages", () => {
    const entries = convertOpenHandsEvents([
      USER_MESSAGE_EVENT,
      AGENT_MESSAGE_EVENT,
    ]);
    expect(entries).toEqual([
      {
        kind: "user",
        text: "Fix the failing test",
        captured_at: "2026-07-04T09:15:23.123456Z",
        source_message_id: "evt-user-1",
      },
      {
        kind: "assistant",
        text: "Done — the test passes now.",
        captured_at: "2026-07-04T09:16:00.000000Z",
        source_message_id: "evt-agent-1",
      },
    ]);
  });

  test("preserves timestamps that already carry a timezone", () => {
    const entries = convertOpenHandsEvents([
      { ...USER_MESSAGE_EVENT, timestamp: "2026-07-04T09:15:23+02:00" },
    ]);
    expect(entries[0]?.captured_at).toBe("2026-07-04T09:15:23+02:00");
  });

  test("pairs actions with observations and emits thought as assistant", () => {
    const entries = convertOpenHandsEvents([ACTION_EVENT, OBSERVATION_EVENT]);
    expect(entries).toEqual([
      {
        kind: "assistant",
        text: "I'll run the tests first.",
        captured_at: "2026-07-04T09:15:30.001122Z",
        source_message_id: "evt-action-1:thought",
      },
      {
        kind: "tool_call",
        name: "terminal",
        argsText: '{"command": "bun test"}',
        resultText: "1 pass, 0 fail",
        resultOk: true,
        captured_at: "2026-07-04T09:15:30.001122Z",
        source_message_id: "evt-action-1",
      },
    ]);
  });

  test("maps agent errors to failed tool results", () => {
    const entries = convertOpenHandsEvents([
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
    ]);
    expect(entries).toEqual([
      {
        kind: "tool_call",
        name: "terminal",
        argsText: '{"command": "bun test"}',
        resultText: "command not found",
        resultOk: false,
        captured_at: "2026-07-04T09:15:30.001122Z",
        source_message_id: "evt-action-1",
      },
    ]);
  });

  test("skips non-conversational events and empty/environment messages", () => {
    const entries = convertOpenHandsEvents([
      { kind: "SystemPromptEvent", id: "evt-sys-1", source: "agent" },
      { kind: "ConversationStateUpdateEvent", id: "evt-state-1" },
      {
        ...USER_MESSAGE_EVENT,
        id: "evt-empty",
        llm_message: { role: "user", content: [] },
      },
      { ...USER_MESSAGE_EVENT, id: "evt-env", source: "environment" },
    ]);
    expect(entries).toEqual([]);
  });
});
