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
import {
  getPostStopRetryExhaustion,
  shouldRetryPostStopTurn,
} from "./turn-send";
import { finishListenerTurn } from "./turn-terminal";

test.each(["end_turn", "cancelled", "llm_api_error"] as const)(
  "finishListenerTurn emits exactly one correlated terminal event for %s",
  async (stopReason) => {
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

    const retryExhaustion =
      stopReason === "llm_api_error"
        ? await getPostStopRetryExhaustion({
            deploymentInterrupted: false,
            deploymentAttempts: 0,
            providerAttempts: 3,
            stopReason,
            runId: null,
            errorDetail: null,
          })
        : undefined;
    expect(
      finishListenerTurn(runtime, lease, {
        turnId: "turn-1",
        stopReason,
        retryExhaustion,
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
        retryExhaustion,
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
    expect(terminalEvents[0]?.retry_exhaustion).toEqual(
      stopReason === "llm_api_error"
        ? { kind: "provider", attempts: 3, max_attempts: 3 }
        : undefined,
    );
  },
);

test("post-stop exhaustion follows the selected budget without changing retry decisions", async () => {
  const provider = {
    deploymentInterrupted: false,
    deploymentAttempts: 0,
    providerAttempts: 3,
    stopReason: "llm_api_error" as const,
    runId: null,
    errorDetail: null,
  };
  expect(await shouldRetryPostStopTurn(provider)).toBe(false);
  expect(await getPostStopRetryExhaustion(provider)).toEqual({
    kind: "provider",
    attempts: 3,
    max_attempts: 3,
  });
  expect(
    await getPostStopRetryExhaustion({ ...provider, providerAttempts: 2 }),
  ).toBeUndefined();

  for (const stopReason of [
    "end_turn",
    "cancelled",
    "requires_approval",
    "max_steps",
    "max_tokens_exceeded",
    "insufficient_credits",
  ] as const) {
    expect(
      await getPostStopRetryExhaustion({ ...provider, stopReason }),
    ).toBeUndefined();
  }
  const deployment = { ...provider, deploymentInterrupted: true };
  expect(await shouldRetryPostStopTurn(deployment)).toBe(true);
  expect(await getPostStopRetryExhaustion(deployment)).toBeUndefined();
  const exhaustedDeployment = { ...deployment, deploymentAttempts: 3 };
  expect(await shouldRetryPostStopTurn(exhaustedDeployment)).toBe(false);
  expect(await getPostStopRetryExhaustion(exhaustedDeployment)).toEqual({
    kind: "deployment",
    attempts: 3,
    max_attempts: 3,
  });
  expect(
    await getPostStopRetryExhaustion({
      ...provider,
      providerAttempts: 0,
      deploymentAttempts: 3,
    }),
  ).toBeUndefined();
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

test("exhausted deployment recovery emits one audience-safe terminal failure", async () => {
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

  const retryExhaustion = await getPostStopRetryExhaustion({
    deploymentInterrupted: true,
    deploymentAttempts: 3,
    providerAttempts: 3,
    stopReason: "error",
    runId: "run-1",
    errorDetail: errorInfo.message,
  });
  finishListenerTurn(runtime, lease, {
    retryExhaustion,
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
  expect(
    payloads.filter((payload) => payload.type === "turn_finished"),
  ).toEqual([
    expect.objectContaining({
      runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
      run_id: "run-1",
      retry_exhaustion: { kind: "deployment", attempts: 3, max_attempts: 3 },
    }),
  ]);
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
