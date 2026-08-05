import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type {
  LettaStreamingResponse,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend, type Backend } from "@/backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import type { StreamRecoveryPolicy } from "@/cli/helpers/stream-recovery";

const capabilities = {
  remoteMemfs: false,
  serverSideToolManagement: false,
  serverSecrets: false,
  agentFileImportExport: false,
  promptRecompile: false,
  byokProviderRefresh: false,
  localModelCatalog: true,
  localMemfs: false,
};

const immediateRecovery: StreamRecoveryPolicy = {
  deadlineMs: 1000,
  initialDelayMs: 0,
  maxAttempts: 4,
  maxDelayMs: 0,
};

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
  stopReason: "end_turn" | "error" | "requires_approval",
): LettaStreamingResponse {
  return {
    message_type: "stop_reason",
    run_id: runId,
    seq_id: seqId,
    stop_reason: stopReason,
  } as LettaStreamingResponse;
}

function run(
  status: NonNullable<Run["status"]>,
  stopReason?: Run["stop_reason"],
  metadata?: Run["metadata"],
): Run {
  return {
    id: "run-1",
    agent_id: "agent-1",
    status,
    stop_reason: stopReason,
    metadata,
  };
}

async function drainWithRecovery(
  initialStream: Stream<LettaStreamingResponse>,
  policy: StreamRecoveryPolicy = immediateRecovery,
) {
  return drainStreamWithResume(
    initialStream,
    createBuffers("agent-1"),
    () => {},
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    policy,
  );
}

afterEach(() => {
  __testSetBackend(null);
});

describe("bounded stream recovery", () => {
  test("advances the sequence cursor when the first resume stream fails", async () => {
    const startingAfter: number[] = [];
    const streamRunMessages = mock(
      async (_runId: string, body: { starting_after?: number | null }) => {
        startingAfter.push(body.starting_after ?? -1);
        if (startingAfter.length === 1) {
          return stream(
            [ping("run-1", 2)],
            new Error("first resume disconnected"),
          );
        }
        return stream([stop("run-1", 3, "end_turn")]);
      },
    );
    const retrieveRun = mock(async () => run("running"));
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun,
    } as unknown as Backend);

    const result = await drainWithRecovery(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.lastSeqId).toBe(3);
    expect(startingAfter).toEqual([1, 2]);
    expect(retrieveRun).toHaveBeenCalledTimes(1);
    expect(result.recoveryFailure).toBeUndefined();
  });

  test("replays a run that becomes requires_approval while reconnecting", async () => {
    const streamRunMessages = mock(async () => {
      if (streamRunMessages.mock.calls.length === 1) {
        throw new Error("resume endpoint unavailable");
      }
      return stream([
        {
          message_type: "approval_request_message",
          run_id: "run-1",
          seq_id: 2,
          tool_call: {
            tool_call_id: "tool-1",
            name: "Bash",
            arguments: '{"command":"pwd"}',
          },
        } as LettaStreamingResponse,
        stop("run-1", 3, "requires_approval"),
      ]);
    });
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => run("completed", "requires_approval")),
    } as unknown as Backend);

    const result = await drainWithRecovery(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
    );

    expect(result.stopReason).toBe("requires_approval");
    expect(result.approvals).toEqual([
      {
        toolCallId: "tool-1",
        toolName: "Bash",
        toolArgs: '{"command":"pwd"}',
      },
    ]);
    expect(streamRunMessages).toHaveBeenCalledTimes(2);
  });

  test("recovers a generic error stop when the API run is still active", async () => {
    const streamRunMessages = mock(async () =>
      stream([stop("run-1", 3, "end_turn")]),
    );
    const retrieveRun = mock(async () => run("running"));
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun,
    } as unknown as Backend);

    const result = await drainWithRecovery(
      stream([ping("run-1", 1), stop("run-1", 2, "error")]),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(streamRunMessages).toHaveBeenCalledTimes(1);
    expect(retrieveRun).toHaveBeenCalledTimes(1);
  });

  test("does not recover a generic error stop from a failed run", async () => {
    const streamRunMessages = mock(async () =>
      stream([stop("run-1", 3, "end_turn")]),
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () =>
        run("failed", "error", { error: { detail: "provider rejected" } }),
      ),
    } as unknown as Backend);

    const result = await drainWithRecovery(
      stream([ping("run-1", 1), stop("run-1", 2, "error")]),
    );

    expect(result.stopReason).toBe("error");
    expect(streamRunMessages).not.toHaveBeenCalled();
    expect(result.recoveryFailure).toBeUndefined();
  });

  test("returns structured failure after bounded attempts leave the run active", async () => {
    const streamRunMessages = mock(async () => {
      throw new Error("resume endpoint unavailable");
    });
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => run("running")),
    } as unknown as Backend);

    const result = await drainWithRecovery(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
      { ...immediateRecovery, maxAttempts: 2 },
    );

    expect(result.stopReason).toBe("error");
    expect(result.fallbackError).toBe("initial stream disconnected");
    expect(result.recoveryFailure).toEqual({
      attempts: 2,
      finalRunStatus: "running",
      finalStopReason: null,
      lastSeqId: 1,
      runId: "run-1",
      underlyingError: "initial stream disconnected",
    });
    expect(streamRunMessages).toHaveBeenCalledTimes(2);
  });

  test("aborts a stalled resume stream at the recovery deadline", async () => {
    const streamRunMessages = mock(
      async (
        _runId: string,
        _body: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        const signal = options?.signal;
        return {
          controller: new AbortController(),
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((_resolve, reject) => {
              const rejectForAbort = () =>
                reject(new Error("resume request aborted"));
              if (signal?.aborted) {
                rejectForAbort();
                return;
              }
              signal?.addEventListener("abort", rejectForAbort, { once: true });
            });
          },
        } as unknown as Stream<LettaStreamingResponse>;
      },
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => run("running")),
    } as unknown as Backend);

    const startedAt = performance.now();
    const result = await drainWithRecovery(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
      { ...immediateRecovery, deadlineMs: 20 },
    );

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(result.stopReason).toBe("error");
    expect(result.recoveryFailure?.attempts).toBe(1);
    expect(result.recoveryFailure?.finalRunStatus).toBe("running");
  });
});
