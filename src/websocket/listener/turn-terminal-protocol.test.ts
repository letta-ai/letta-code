import { expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import type { ListenerTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";

test("finishListenerTurn emits exactly one correlated terminal event", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const sent: string[] = [];
  const socket: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => sent.push(payload),
  };
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });

  expect(
    finishListenerTurn(runtime, lease, {
      turnId: "turn-1",
      stopReason: "end_turn",
      socket,
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "conv-1",
    }).finished,
  ).toBe(true);
  expect(
    finishListenerTurn(runtime, lease, {
      turnId: "turn-1",
      stopReason: "end_turn",
      socket,
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "conv-1",
    }).finished,
  ).toBe(false);

  const terminalEvents = sent
    .map((payload) => JSON.parse(payload) as Record<string, unknown>)
    .filter((message) => message.type === "turn_finished");
  expect(terminalEvents).toEqual([
    expect.objectContaining({
      type: "turn_finished",
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      turn_id: "turn-1",
      run_id: "run-1",
      stop_reason: "end_turn",
    }),
  ]);
});
