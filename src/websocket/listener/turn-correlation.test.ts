import { expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { buildLoopStatus } from "./protocol-outbound";
import { createTurnCorrelation } from "./turn-correlation";

function createTestRuntime() {
  const listener = createRuntime();
  return getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
}

test("notification inputs publish placement OTIDs without changing send lineage", () => {
  const runtime = createTestRuntime();
  runtime.dequeuedClientMessageIdsByBatchId.set("notification", [
    "cm-original",
  ]);
  const turn = createTurnCorrelation(
    runtime,
    {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [
        { role: "user", content: "notification", otid: "notice-otid" },
      ],
    },
    "notification",
  );
  turn.observeRun("run-notice");
  turn.observeRun("run-notice");
  expect(turn.clientMessageIds).toEqual(["cm-original"]);
  expect(buildLoopStatus(runtime).client_message_ids_by_run_id).toEqual({
    "run-notice": ["cm-original", "notice-otid"],
  });
});

test("notification inputs without send lineage still publish placement OTIDs", () => {
  const runtime = createTestRuntime();
  const turn = createTurnCorrelation(
    runtime,
    {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [
        { role: "user", content: "notification", otid: "notice-otid" },
      ],
    },
    "notification",
  );
  turn.observeRun("run-notice");
  expect(turn.clientMessageIds).toEqual([]);
  expect(buildLoopStatus(runtime).client_message_ids_by_run_id).toEqual({
    "run-notice": ["notice-otid"],
  });
});
