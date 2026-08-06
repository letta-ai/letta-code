import { expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/error";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  getConsumerLoopErrorMessage,
  getLoopErrorNoticeDecision,
  getTranscriptLoopErrorMessage,
} from "./recoverable-notices";
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

test("terminal error formatting preserves classifications and rejects raw fallbacks", () => {
  const unknownApiError = new APIError(
    500,
    { detail: "upstream credential leaked" },
    undefined,
    new Headers(),
  );
  const safeMessages = [
    getTranscriptLoopErrorMessage({
      message: unknownApiError.message,
      error: unknownApiError,
    }),
    getTranscriptLoopErrorMessage({
      message: "unknown object",
      error: { detail: "private object detail", token: "secret-value" },
    }),
  ];

  expect(safeMessages).toEqual([
    "The request failed. Please try again.",
    "The request failed. Please try again.",
  ]);
  expect(JSON.stringify(safeMessages)).not.toContain("credential leaked");
  expect(JSON.stringify(safeMessages)).not.toContain("private object detail");
  expect(JSON.stringify(safeMessages)).not.toContain("secret-value");
  expect(
    getTranscriptLoopErrorMessage({ message: "terminated" }),
  ).toBeUndefined();
  expect(getLoopErrorNoticeDecision({ message: "terminated" }).visibility).toBe(
    "debug_only",
  );
});

test("consumer terminal errors match the plain loop error", () => {
  expect(
    getConsumerLoopErrorMessage({
      message: "The usage limit has been reached",
    }),
  ).toBe("The usage limit has been reached");
  expect(
    getConsumerLoopErrorMessage({ message: "terminated" }),
  ).toBeUndefined();
});
