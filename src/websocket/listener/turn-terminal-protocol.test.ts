import { expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/error";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  emitLoopErrorNotice,
  getConsumerLoopErrorMessage,
  getLoopErrorNoticeDecision,
  getTranscriptLoopErrorMessage,
} from "./recoverable-notices";
import type { ListenerTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";

test.each(["end_turn", "error"] as const)(
  "finishListenerTurn emits exactly one correlated terminal event (%s)",
  (stopReason) => {
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
        stopReason,
        ...(stopReason === "error"
          ? {
              errorNotice: {
                message: "Message author is not authorized",
                clientMessageIds: ["cm-1"],
              },
            }
          : {}),
        socket,
        runId: "run-1",
        agentId: "agent-1",
        conversationId: "conv-1",
        usage: { total_tokens: 42, step_count: 2 },
      }).finished,
    ).toBe(true);
    expect(
      finishListenerTurn(runtime, lease, {
        turnId: "turn-1",
        stopReason,
        ...(stopReason === "error"
          ? {
              errorNotice: {
                message: "Message author is not authorized",
                clientMessageIds: ["cm-1"],
              },
            }
          : {}),
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
        stop_reason: stopReason,
        usage: { total_tokens: 42, step_count: 2 },
      }),
    ]);
    expect(
      sent.filter((payload) => payload.includes('"message_type":"loop_error"')),
    ).toHaveLength(stopReason === "error" ? 1 : 0);
  },
);

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

test("exhausted deployment recovery emits one audience-safe terminal failure", () => {
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
  const errorInfo = {
    message: "Cloud API deployment interrupted the accepted run",
    error_type: "internal_error",
    error_code: "cloud_api_deployment_interrupted",
    status_code: 503,
    retryable: true,
    run_id: "run-1",
  };
  const terminalError = getConsumerLoopErrorMessage({
    message: errorInfo.message,
    errorInfo,
  });

  finishListenerTurn(runtime, lease, {
    turnId: "turn-1",
    stopReason: "error",
    socket,
    runId: "run-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    error: terminalError,
  });
  emitLoopErrorNotice(socket, runtime, {
    message: errorInfo.message,
    stopReason: "error",
    isTerminal: true,
    runId: "run-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    errorInfo,
  });

  const payloads = sent.map((payload) => JSON.parse(payload));
  const loopErrors = payloads.filter(
    (payload) =>
      payload.type === "stream_delta" &&
      payload.delta?.message_type === "loop_error",
  );
  expect(loopErrors).toHaveLength(1);
  expect(loopErrors[0]?.delta).toMatchObject({
    message: "Service temporarily unavailable. Please retry your request.",
    is_terminal: true,
  });
  expect(JSON.stringify(payloads)).not.toContain(
    "cloud_api_deployment_interrupted",
  );
  expect(JSON.stringify(payloads)).not.toContain("deployment interrupted");
});

test("consumer terminal errors hide Cloud API shutdown metadata", () => {
  const error = new APIError(
    503,
    {
      error: "Service temporarily unavailable. Please retry your request.",
      errorCode: "cloud_api_shutting_down",
      admitted: false,
      retryable: true,
    },
    undefined,
    new Headers({ "Retry-After": "1" }),
  );

  const message = getConsumerLoopErrorMessage({
    message: error.message,
    error,
  });

  expect(message).toBe(
    "Service temporarily unavailable. Please retry your request.",
  );
  expect(message).not.toContain("cloud_api_shutting_down");
});

test("semantic proxy-wrapped 400 errors are not reported as service outages", () => {
  const error = new APIError(
    400,
    {
      detail:
        "Error occurred while trying to proxy: No active runs found for this conversation.",
    },
    undefined,
    new Headers(),
  );

  const message = getConsumerLoopErrorMessage({
    message: error.message,
    error,
  });

  expect(message).not.toBe("Connection to Letta service failed. Please retry.");
});

test("proxy transport 5xx errors retain the service outage message", () => {
  const error = new APIError(
    504,
    {
      detail: "Error occurred while trying to proxy to: https://api.letta.com",
    },
    undefined,
    new Headers(),
  );

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
    }),
  ).toBe("Connection to Letta service failed. Please retry.");
});
