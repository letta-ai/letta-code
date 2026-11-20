import { expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { buildLoopStatus } from "./protocol-outbound";
import { evictConversationRuntimeIfIdle } from "./runtime";
import { createTurnCorrelation } from "./turn-correlation";

function createTestRuntime() {
  const listener = createRuntime();
  return getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
}

test("turn correlation re-emits when a continuation adds queued sends", () => {
  const runtime = createTestRuntime();
  runtime.dequeuedClientMessageIdsByBatchId.set("batch-1", ["cm-1", "cm-2"]);
  const turnCorrelation = createTurnCorrelation(
    runtime,
    {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: "hello", client_message_id: "cm-1" }],
    },
    "batch-1",
  );
  turnCorrelation.observeRun("run-1");
  runtime.dequeuedClientMessageIdsByBatchId.set("batch-2", ["cm-3"]);
  turnCorrelation.appendDequeuedBatch("batch-2");
  turnCorrelation.observeRun("run-1");

  expect(buildLoopStatus(runtime).client_message_ids_by_run_id).toEqual({
    "run-1": ["cm-1", "cm-2", "cm-3"],
  });
  expect(runtime.dequeuedClientMessageIdsByBatchId.size).toBe(0);
});

test("direct turns publish their run-to-send correlation in loop snapshots", () => {
  const runtime = createTestRuntime();
  const turnCorrelation = createTurnCorrelation(
    runtime,
    {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: "hello", client_message_id: "cm-1" }],
    },
    "batch-direct-1",
  );
  turnCorrelation.observeRun("run-1");

  expect(buildLoopStatus(runtime).client_message_ids_by_run_id).toEqual({
    "run-1": ["cm-1"],
  });
});

test("correlations survive idle runtime eviction for reconnect snapshots", () => {
  const runtime = createTestRuntime();
  createTurnCorrelation(
    runtime,
    {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: "hello", client_message_id: "cm-1" }],
    },
    "batch-direct-1",
  ).observeRun("run-1");

  expect(evictConversationRuntimeIfIdle(runtime)).toBe(true);
  const replacement = getOrCreateScopedRuntime(
    runtime.listener,
    "agent-1",
    "conv-1",
  );
  expect(buildLoopStatus(replacement).client_message_ids_by_run_id).toEqual({
    "run-1": ["cm-1"],
  });
});

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
