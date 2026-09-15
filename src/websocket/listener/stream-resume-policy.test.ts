import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend, type Backend } from "@/backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { LISTENER_STREAM_RESUME_POLICY } from "./constants";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { drainRecoveryStreamWithEmission } from "./recovery";
import type { LocalTransport } from "./transport";
import { drainTurnStreamWithEmission } from "./turn-stream";
import type { StartListenerOptions } from "./types";

const capabilities = {
  remoteMemfs: false,
  serverSideToolManagement: false,
  serverSecrets: false,
  promptRecompile: false,
  byokProviderRefresh: false,
  localModelCatalog: true,
  localMemfs: false,
};

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

function createTestRuntime(transport: MockTransport) {
  const listener = createRuntime();
  const options: StartListenerOptions = {
    connectionId: "test-connection",
    wsUrl: "local://test",
    deviceId: "test-device",
    connectionName: "test-connection",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  subscribeListenerConnection(listener, options.connectionId, {
    agent_id: "agent-1",
    conversation_id: "conversation-1",
  });
  return getOrCreateScopedRuntime(listener, "agent-1", "conversation-1");
}

function stream(
  chunks: LettaStreamingResponse[],
  error?: Error,
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      if (error) throw error;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function ping(runId: string, seqId: number): LettaStreamingResponse {
  return {
    message_type: "ping",
    run_id: runId,
    seq_id: seqId,
  } as unknown as LettaStreamingResponse;
}

function stop(
  runId: string,
  seqId: number,
  stopReason: "end_turn" | "error",
): LettaStreamingResponse {
  return {
    message_type: "stop_reason",
    run_id: runId,
    seq_id: seqId,
    stop_reason: stopReason,
  } as LettaStreamingResponse;
}

function totalWaitMs(policy: typeof LISTENER_STREAM_RESUME_POLICY): number {
  let total = 0;
  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    total += Math.min(
      policy.initialDelayMs * 2 ** (attempt - 1),
      policy.maxDelayMs,
    );
  }
  return total;
}

function backendThatFailsFirstResume(): { startingAfter: number[] } {
  const startingAfter: number[] = [];
  const streamRunMessages = mock(
    async (_runId: string, body: { starting_after?: number | null }) => {
      startingAfter.push(body.starting_after ?? -1);
      if (startingAfter.length === 1) {
        // cloud-api is still down when the first resume is attempted.
        throw new Error("socket closed unexpectedly");
      }
      return stream([stop("run-1", 2, "end_turn")]);
    },
  );
  const retrieveRun = mock(async () => {
    throw new Error("socket closed unexpectedly");
  });
  __testSetBackend({
    capabilities,
    streamRunMessages,
    retrieveRun,
  } as unknown as Backend);
  return { startingAfter };
}

afterEach(() => {
  __testSetBackend(null as unknown as Backend);
});

describe("listener stream resume policy", () => {
  test("waits about five minutes across resume attempts", () => {
    // A cloud-api rolling restart takes minutes, and after reconnecting the
    // server waits 90 s of producer silence before reporting loss. One
    // immediate attempt (the drainStreamWithResume default) covers neither.
    const waitMs = totalWaitMs(LISTENER_STREAM_RESUME_POLICY);
    expect(LISTENER_STREAM_RESUME_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(waitMs).toBeGreaterThanOrEqual(4 * 60_000);
    expect(waitMs).toBeLessThanOrEqual(6 * 60_000);
  });

  test("turn drain retries the run stream after the first resume fails", async () => {
    const { startingAfter } = backendThatFailsFirstResume();
    const transport = new MockTransport();
    const runtime = createTestRuntime(transport);
    const turnLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    const msgRunIds: string[] = [];

    try {
      const drained = await drainTurnStreamWithEmission(
        stream([ping("run-1", 1)], new Error("socket closed unexpectedly")),
        createBuffers("agent-1"),
        transport,
        runtime,
        {
          agentId: "agent-1",
          conversationId: "conversation-1",
          turnLease,
          turnCorrelation: {
            appendDequeuedBatch: () => {},
            observeRun: () => {},
          },
          msgRunIds,
          runId: undefined,
        },
      );

      expect(drained.result.stopReason).toBe("end_turn");
      expect(drained.runId).toBe("run-1");
      expect(msgRunIds).toEqual(["run-1"]);
      expect(startingAfter).toEqual([1, 1]);
    } finally {
      runtime.turnLifecycle.finish(turnLease, "end_turn");
    }
  });

  test("confirmed deployment interruption stays hidden during run replay", async () => {
    const transport = new MockTransport();
    const runtime = createTestRuntime(transport);
    const turnLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    __testSetBackend({
      capabilities,
      streamRunMessages: async () =>
        stream([
          {
            message_type: "error_message",
            message: "Cloud API deployment interrupted the accepted run",
            error_type: "internal_error",
            error_code: "cloud_api_deployment_interrupted",
            status_code: 503,
            retryable: true,
            run_id: "run-1",
            seq_id: 2,
          } as never,
          stop("run-1", 3, "error"),
        ]),
      retrieveRun: async () => ({
        status: "completed",
        stop_reason: "error",
        metadata: {
          error: {
            error_type: "internal_error",
            error_code: "cloud_api_deployment_interrupted",
            status_code: 503,
            retryable: true,
          },
        },
      }),
    } as unknown as Backend);

    try {
      const drained = await drainTurnStreamWithEmission(
        stream([ping("run-1", 1)], new Error("socket closed unexpectedly")),
        createBuffers("agent-1"),
        transport,
        runtime,
        {
          agentId: "agent-1",
          conversationId: "conversation-1",
          turnLease,
          turnCorrelation: {
            appendDequeuedBatch: () => {},
            observeRun: () => {},
          },
          msgRunIds: [],
          runId: undefined,
        },
      );

      expect(drained.result.errorInfo?.error_code).toBe(
        "cloud_api_deployment_interrupted",
      );
      expect(
        transport.sent
          .map((payload) => JSON.parse(payload))
          .filter(
            (payload) =>
              payload.type === "stream_delta" &&
              (payload.delta?.message_type === "loop_error" ||
                payload.delta?.message_type === "error_message"),
          ),
      ).toEqual([]);
    } finally {
      runtime.turnLifecycle.finish(turnLease, "error");
    }
  });

  test("recovery drain retries the run stream after the first resume fails", async () => {
    const { startingAfter } = backendThatFailsFirstResume();
    const transport = new MockTransport();
    const runtime = createTestRuntime(transport);
    const turnLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });

    try {
      const result = await drainRecoveryStreamWithEmission(
        stream([ping("run-1", 1)], new Error("socket closed unexpectedly")),
        transport,
        runtime,
        {
          agentId: "agent-1",
          conversationId: "conversation-1",
          turnLease,
        },
      );

      expect(result.stopReason).toBe("end_turn");
      expect(result.lastRunId).toBe("run-1");
      expect(startingAfter).toEqual([1, 1]);
    } finally {
      runtime.turnLifecycle.finish(turnLease, "end_turn");
    }
  });
});
