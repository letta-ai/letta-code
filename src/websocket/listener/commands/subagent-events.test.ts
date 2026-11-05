import { afterEach, expect, test } from "bun:test";
import {
  readSubagentEvents,
  serveSubagentEvents,
  storeSubagentEvent,
} from "@/agent/subagent-events";
import { clearAllSubagents, registerSubagent } from "@/agent/subagent-state";
import { isReadSubagentEventsCommand } from "@/websocket/listener/subagent-protocol-inbound";
import { handleReadSubagentEventsCommand } from "./subagent-events";

const runtime = { agent_id: "agent-parent", conversation_id: "conv-parent" };
const command = (after_seq = 0) => ({
  type: "read_subagent_events" as const,
  request_id: "req-1",
  runtime,
  subagent_id: "subagent-1",
  after_seq,
});

afterEach(() => clearAllSubagents());

function register(conversationId: string): void {
  registerSubagent("subagent-1", "claude-code", "Fix", "call-1", true, false, {
    agentId: runtime.agent_id,
    conversationId,
  });
  serveSubagentEvents("subagent-1");
}

test("serves the launching conversation a page of events after a seq", () => {
  register(runtime.conversation_id);
  expect(isReadSubagentEventsCommand(command(1))).toBe(true);
  expect(isReadSubagentEventsCommand(command(-1))).toBe(false);
  const big = "y".repeat(300 * 1024);
  storeSubagentEvent("subagent-1", {
    seq: 1,
    at: "t",
    type: "text",
    text: "hi",
  });
  storeSubagentEvent("subagent-1", {
    seq: 2,
    at: "t",
    type: "text",
    text: big,
  });

  const response = handleReadSubagentEventsCommand(command(1));
  expect(response).toMatchObject({
    success: true,
    next_seq: 2,
    has_more: false,
    missed: 0,
  });
  // An oversized event is cut with a marker, not dropped.
  const [event] = response.success ? response.events : [];
  expect(event?.seq).toBe(2);
  expect(String(event?.text)).toEndWith("bytes]");
  expect(Number(event?.truncated_bytes)).toBeGreaterThan(40 * 1024);
  expect(JSON.stringify(event).length).toBeLessThanOrEqual(256 * 1024);
  expect(readSubagentEvents("subagent-1", 0, 1)?.has_more).toBe(true);
});

test("refuses another conversation's subagent", () => {
  register("conv-other");
  expect(handleReadSubagentEventsCommand(command())).toMatchObject({
    success: false,
    error: "Subagent does not belong to this conversation",
  });
});
