import { afterEach, describe, expect, test } from "bun:test";
import {
  serveSubagentEvents,
  storeSubagentEvent,
} from "@/agent/subagent-events";
import { clearAllSubagents, registerSubagent } from "@/agent/subagent-state";
import { isReadSubagentEventsCommand } from "@/websocket/listener/subagent-protocol-inbound";
import { handleReadSubagentEventsCommand } from "./subagent-events";

const runtime = { agent_id: "agent-parent", conversation_id: "conv-parent" };

function command(overrides: Record<string, unknown> = {}) {
  return {
    type: "read_subagent_events" as const,
    request_id: "req-1",
    runtime,
    subagent_id: "subagent-1",
    after_seq: 0,
    ...overrides,
  };
}

afterEach(() => clearAllSubagents());

describe("read_subagent_events", () => {
  test("validates the command shape", () => {
    expect(isReadSubagentEventsCommand(command())).toBe(true);
    expect(isReadSubagentEventsCommand(command({ max_bytes: 4096 }))).toBe(
      true,
    );
    expect(isReadSubagentEventsCommand(command({ after_seq: -1 }))).toBe(false);
    expect(isReadSubagentEventsCommand(command({ after_seq: 1.5 }))).toBe(
      false,
    );
    expect(isReadSubagentEventsCommand(command({ subagent_id: " " }))).toBe(
      false,
    );
    expect(isReadSubagentEventsCommand(command({ max_bytes: 0 }))).toBe(false);
  });

  test("serves a page of the launching conversation's subagent events", () => {
    registerSubagent(
      "subagent-1",
      "claude-code",
      "Fix the bug",
      "call-1",
      true,
      false,
      { agentId: runtime.agent_id, conversationId: runtime.conversation_id },
    );
    serveSubagentEvents("subagent-1");
    storeSubagentEvent("subagent-1", {
      seq: 1,
      at: "t",
      type: "text",
      text: "hi",
    });
    storeSubagentEvent("subagent-1", {
      seq: 2,
      at: "t",
      type: "tool_result",
      tool_call_id: "c1",
      is_error: false,
      output: "ok",
    });
    expect(handleReadSubagentEventsCommand(command({ after_seq: 1 }))).toEqual({
      type: "read_subagent_events_response",
      request_id: "req-1",
      runtime,
      subagent_id: "subagent-1",
      success: true,
      events: [
        {
          seq: 2,
          at: "t",
          type: "tool_result",
          tool_call_id: "c1",
          is_error: false,
          output: "ok",
        },
      ],
      next_seq: 2,
      has_more: false,
      missed: 0,
    });
  });

  test("refuses another conversation's subagent", () => {
    registerSubagent(
      "subagent-1",
      "claude-code",
      "Fix the bug",
      "call-1",
      true,
      false,
      { agentId: runtime.agent_id, conversationId: "conv-other" },
    );
    serveSubagentEvents("subagent-1");
    expect(handleReadSubagentEventsCommand(command())).toMatchObject({
      success: false,
      error: "Subagent does not belong to this conversation",
    });
    expect(
      handleReadSubagentEventsCommand(command({ subagent_id: "missing" })),
    ).toMatchObject({ success: false });
  });
});
