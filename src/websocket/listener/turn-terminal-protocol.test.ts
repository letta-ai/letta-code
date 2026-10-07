import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIError } from "@letta-ai/letta-client/error";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { readInterruptedTurnAuthorityRevision } from "./interrupted-turn-read";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import { createRuntime } from "./lifecycle";
import {
  emitLoopErrorNotice,
  getConsumerLoopErrorMessage,
  getLoopErrorNoticeDecision,
  getTranscriptLoopErrorMessage,
} from "./recoverable-notices";
import type { ListenerTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";

test("recovery terminal fencing can read predecessor lineage instead of successor main", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const lease = runtime.turnLifecycle.begin({
    origin: "approval_recovery",
    workingDirectory: process.cwd(),
  });

  expect(
    finishListenerTurn(runtime, lease, {
      stopReason: "end_turn",
      conversationId: "conv-1",
      expectedInterruptedRevision: "revision-predecessor",
      readInterruptedRevision: () => "revision-predecessor",
      forgetWork: () => {},
    }).finished,
  ).toBe(true);
});

test("recovery terminal fencing rejects a stale sidecar generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-sidecar-fence-"));
  const store = createInterruptedTurnStore(directory);
  const lineageId = "lineage-terminal";
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  try {
    const predecessor = store.write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-predecessor",
      toolCallIds: ["call-1"],
      results: [],
      requestOtid: "request-predecessor",
      workingDirectory: "/predecessor",
      recoveryClaimCompletion: {
        lineageId,
        state: "running",
        effectToolCallIds: ["call-1"],
      },
    });
    store.write(
      {
        ...predecessor,
        runId: "run-successor",
        toolCallIds: ["call-successor"],
        requestOtid: "request-successor",
        recoveryClaimCompletion: {
          lineageId,
          state: "running",
          independentSuccessor: true,
          effectRevision: predecessor.revision,
          effectToolCallIds: predecessor.toolCallIds,
          effectRunId: predecessor.runId,
          effectRequestOtid: predecessor.requestOtid,
          effectWorkingDirectory: predecessor.workingDirectory,
          effectResults: predecessor.results,
        },
      },
      predecessor.revision,
    );
    const observed = store.readRecoverySnapshot("agent-1", "conv-1", lineageId);
    if (!observed) throw new Error("missing recovery snapshot");
    store.writeRecoveryLineageSnapshot({
      agentId: "agent-1",
      conversationId: "conv-1",
      lineageId,
      expectedSidecarRevision: observed.revisionToken,
      update: { results: [], unstartedToolCallIds: ["call-1"] },
    });
    const lease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });
    expect(
      finishListenerTurn(runtime, lease, {
        stopReason: "end_turn",
        conversationId: "conv-1",
        expectedInterruptedRevision: predecessor.revision,
        readInterruptedRevision: () => predecessor.revision,
        expectedInterruptedAuthorityRevision: observed.revisionToken,
        readInterruptedAuthorityRevision: () =>
          store.readRecoverySnapshot("agent-1", "conv-1", lineageId)
            ?.revisionToken,
        forgetWork: () => {},
      }).finished,
    ).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordinary recovery terminal fencing uses the main record revision", () => {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "terminal-main-fence-"));
  process.env.HOME = home;
  const lineageId = "lineage-main";
  const listener = createRuntime();
  listener.connectionId = "conn-main-fence";
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  try {
    const record = createInterruptedTurnStore().write({
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-main",
      toolCallIds: [],
      results: [],
      requestOtid: "request-main",
      workingDirectory: "/main",
      recoveryClaimCompletion: { lineageId, state: "running" },
    });
    const lease = runtime.turnLifecycle.begin({
      origin: "approval_recovery",
      workingDirectory: process.cwd(),
    });
    expect(
      finishListenerTurn(runtime, lease, {
        stopReason: "end_turn",
        conversationId: "conv-1",
        expectedInterruptedRevision: record.revision,
        readInterruptedRevision: () => record.revision,
        expectedInterruptedAuthorityRevision: record.revision,
        readInterruptedAuthorityRevision: () =>
          readInterruptedTurnAuthorityRevision(runtime, lineageId),
        forgetWork: () => {},
      }).finished,
    ).toBe(true);
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

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
