import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIError } from "@letta-ai/letta-client/error";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
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
import { createTurnFinishedStore } from "./turn-finished-replay";
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

test("terminal consumers without a client identity persist a rotatable terminal", () => {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "identityless-terminal-"));
  process.env.HOME = home;
  const listener = createRuntime();
  listener.connectionId = "conn-identityless";
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket: ListenerTransport = {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
  try {
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    expect(
      finishListenerTurn(runtime, lease, {
        turnId: "turn-identityless",
        stopReason: "end_turn",
        socket,
        agentId: "agent-1",
        conversationId: "conv-1",
        terminalConsumerIds: ["slack:agent-1"],
        durableInputIdentities: [],
        forgetWork: () => {},
      }).finished,
    ).toBe(true);
    expect(
      createTurnFinishedStore().read("agent-1", "conv-1")?.terminals,
    ).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          turn_id: "turn-identityless",
          terminal_consumer_ids: ["slack:agent-1"],
        }),
        owner: expect.objectContaining({
          connectionId: null,
          canRotate: true,
        }),
      }),
    ]);
  } finally {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
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

test("structured proxy-wrapped 400 errors are not reported as service outages", () => {
  const message = getConsumerLoopErrorMessage({
    message:
      "Error occurred while trying to proxy: No active runs found for this conversation.",
    errorInfo: {
      message:
        "Error occurred while trying to proxy: No active runs found for this conversation.",
      detail:
        "Error occurred while trying to proxy: No active runs found for this conversation.",
      status_code: 400,
    },
  });

  expect(message).not.toBe("Connection to Letta service failed. Please retry.");
});

test("nested run errors with proxy-wrapped 400s are not reported as outages", () => {
  const proxyMessage =
    "Error occurred while trying to proxy: No active runs found for this conversation.";
  const error = Object.assign(new Error(proxyMessage), {
    runErrorInfo: {
      message: proxyMessage,
      detail: proxyMessage,
      status_code: 400,
      error_type: "internal_error",
      run_id: "run-1",
    },
  });

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
    }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
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

test("noncanonical proxy 5xx errors retain the service outage message", () => {
  const error = new APIError(
    504,
    {
      detail:
        "Upstream timed out while trying to proxy to https://api.letta.com",
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

test("structured 5xx status is used when APIError status is undefined", () => {
  const detail = "Upstream timed out while trying to proxy to api.letta.com";
  const error = new APIError(
    undefined as unknown as number,
    { detail },
    undefined,
    new Headers(),
  );

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
      errorInfo: { message: detail, detail, status_code: 502 },
    }),
  ).toBe("Connection to Letta service failed. Please retry.");
});

test("structured 4xx status is used when APIError status is undefined", () => {
  const detail =
    "Error occurred while trying to proxy: No active runs found for this conversation.";
  const error = new APIError(
    undefined as unknown as number,
    { detail },
    undefined,
    new Headers(),
  );

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
      errorInfo: { message: detail, detail, status_code: 400 },
    }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
});

test("direct apiError 4xx status prevents proxy outage classification", () => {
  const detail =
    "Error occurred while trying to proxy: No active runs found for this conversation.";

  expect(
    getConsumerLoopErrorMessage({
      message: detail,
      apiError: {
        message_type: "error_message",
        message: detail,
        detail,
        error_type: "invalid_request_error",
        run_id: "run-1",
        status_code: 400,
      } as LettaStreamingResponse.LettaErrorMessage,
    }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
});

test("direct apiError 5xx status preserves proxy outage classification", () => {
  const detail = "Upstream timed out while trying to proxy to api.letta.com";

  expect(
    getConsumerLoopErrorMessage({
      message: detail,
      apiError: {
        message_type: "error_message",
        message: detail,
        detail,
        error_type: "server_error",
        run_id: "run-1",
        status_code: 503,
      } as LettaStreamingResponse.LettaErrorMessage,
    }),
  ).toBe("Connection to Letta service failed. Please retry.");
});

test("nested apiError 4xx status prevents proxy outage classification", () => {
  const detail =
    "Error occurred while trying to proxy: No active runs found for this conversation.";
  const error = Object.assign(new Error(detail), {
    apiError: {
      message_type: "error_message",
      message: detail,
      detail,
      error_type: "invalid_request_error",
      run_id: "run-1",
      status_code: 400,
    },
  });

  expect(
    getConsumerLoopErrorMessage({ message: error.message, error }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
});

test("nested apiError 5xx status preserves proxy outage classification", () => {
  const detail = "Upstream timed out while trying to proxy to api.letta.com";
  const error = Object.assign(new Error(detail), {
    apiError: {
      message_type: "error_message",
      message: detail,
      detail,
      error_type: "server_error",
      run_id: "run-1",
      status_code: 503,
    },
  });

  expect(getConsumerLoopErrorMessage({ message: error.message, error })).toBe(
    "Connection to Letta service failed. Please retry.",
  );
});

test("nested structured detail participates in known 5xx proxy detection", () => {
  const detail = "Upstream timed out while trying to proxy to api.letta.com";
  const error = Object.assign(new Error("request failed"), {
    runErrorInfo: { message: "request failed", detail, status_code: 502 },
  });

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
    }),
  ).toBe("Connection to Letta service failed. Please retry.");
});

test("nested canonical detail retains the no-status proxy fallback", () => {
  const detail = "Error occurred while trying to proxy to api.letta.com";
  const error = Object.assign(new Error("request failed"), {
    errorInfo: { message: "request failed", detail },
  });

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
    }),
  ).toBe("Connection to Letta service failed. Please retry.");
});

test("run status and proxy detail stay paired when stream info has no status", () => {
  const runDetail = "Upstream timed out while trying to proxy to api.letta.com";

  expect(
    getConsumerLoopErrorMessage({
      message: "stream failed",
      errorInfo: { message: "stream failed", detail: "stream failed" },
      runErrorInfo: {
        message: runDetail,
        detail: runDetail,
        status_code: 503,
      },
    }),
  ).toBe("Connection to Letta service failed. Please retry.");
});

test("nested run status and proxy detail stay paired", () => {
  const runDetail = "Upstream timed out while trying to proxy to api.letta.com";
  const error = Object.assign(new Error("stream failed"), {
    errorInfo: { message: "stream failed", detail: "stream failed" },
    runErrorInfo: { message: runDetail, detail: runDetail, status_code: 503 },
  });

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
    }),
  ).toBe("Connection to Letta service failed. Please retry.");
});

test("broad proxy wording without status is not classified as an outage", () => {
  const detail = "Upstream timed out while trying to proxy to api.letta.com";

  expect(
    getConsumerLoopErrorMessage({
      message: "request failed",
      errorInfo: { message: "request failed", detail },
    }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
});

test("status and proxy marker are not combined across direct sources", () => {
  const proxyDetail =
    "Upstream timed out while trying to proxy to api.letta.com";

  expect(
    getConsumerLoopErrorMessage({
      message: proxyDetail,
      errorInfo: { message: proxyDetail, detail: proxyDetail },
      runErrorInfo: {
        message: "run metadata unavailable",
        detail: "run metadata unavailable",
        status_code: 503,
      },
    }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
});

test("status and proxy marker are not combined across nested sources", () => {
  const proxyDetail =
    "Upstream timed out while trying to proxy to api.letta.com";
  const error = Object.assign(new Error(proxyDetail), {
    errorInfo: { message: proxyDetail, detail: proxyDetail },
    runErrorInfo: {
      message: "run metadata unavailable",
      detail: "run metadata unavailable",
      status_code: 503,
    },
  });

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
    }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
});

test("status-only run metadata does not borrow direct proxy text", () => {
  const proxyDetail = "Error occurred while trying to proxy to api.letta.com";

  expect(
    getConsumerLoopErrorMessage({
      message: proxyDetail,
      errorInfo: { message: proxyDetail, detail: proxyDetail },
      runErrorInfo: { error_type: "server_error", status_code: 503 },
    }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
});

test("status-only nested metadata does not borrow nested proxy text", () => {
  const proxyDetail = "Error occurred while trying to proxy to api.letta.com";
  const error = Object.assign(new Error(proxyDetail), {
    errorInfo: { message: proxyDetail, detail: proxyDetail },
    runErrorInfo: { error_type: "server_error", status_code: 503 },
  });

  expect(
    getConsumerLoopErrorMessage({
      message: error.message,
      error,
    }),
  ).not.toBe("Connection to Letta service failed. Please retry.");
});
