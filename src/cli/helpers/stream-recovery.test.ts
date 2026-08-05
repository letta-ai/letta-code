import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type {
  LettaStreamingResponse,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend, type Backend } from "@/backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import type { StreamResumePolicy } from "@/cli/helpers/stream-resume";

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

const immediateRetries: StreamResumePolicy = {
  initialDelayMs: 0,
  maxAttempts: 3,
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
  stopReason: "end_turn" | "error",
): LettaStreamingResponse {
  return {
    message_type: "stop_reason",
    run_id: runId,
    seq_id: seqId,
    stop_reason: stopReason,
  } as LettaStreamingResponse;
}

function runningRun(): Run {
  return {
    id: "run-1",
    agent_id: "agent-1",
    status: "running",
  };
}

async function drain(initialStream: Stream<LettaStreamingResponse>) {
  return drainStreamWithResume(
    initialStream,
    createBuffers("agent-1"),
    () => {},
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    immediateRetries,
  );
}

afterEach(() => {
  __testSetBackend(null);
});

describe("stream recovery", () => {
  test("retries the same run when the first resume request fails", async () => {
    const startingAfter: number[] = [];
    const streamRunMessages = mock(
      async (_runId: string, body: { starting_after?: number | null }) => {
        startingAfter.push(body.starting_after ?? -1);
        if (startingAfter.length === 1) {
          throw new Error("resume endpoint unavailable");
        }
        return stream([stop("run-1", 2, "end_turn")]);
      },
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
    } as unknown as Backend);

    const result = await drain(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.lastRunId).toBe("run-1");
    expect(result.lastSeqId).toBe(2);
    expect(startingAfter).toEqual([1, 1]);
  });

  test("advances the cursor when a resumed stream also disconnects", async () => {
    const startingAfter: number[] = [];
    const streamRunMessages = mock(
      async (_runId: string, body: { starting_after?: number | null }) => {
        startingAfter.push(body.starting_after ?? -1);
        if (startingAfter.length === 1) {
          return stream(
            [ping("run-1", 2)],
            new Error("resumed stream disconnected"),
          );
        }
        return stream([stop("run-1", 3, "end_turn")]);
      },
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
    } as unknown as Backend);

    const result = await drain(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(result.lastSeqId).toBe(3);
    expect(startingAfter).toEqual([1, 2]);
  });

  test("replays a generic error stop when the run is still active", async () => {
    const streamRunMessages = mock(async () =>
      stream([stop("run-1", 3, "end_turn")]),
    );
    const retrieveRun = mock(async () => runningRun());
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun,
    } as unknown as Backend);

    const result = await drain(
      stream([ping("run-1", 1), stop("run-1", 2, "error")]),
    );

    expect(result.stopReason).toBe("end_turn");
    expect(streamRunMessages).toHaveBeenCalledTimes(1);
    expect(retrieveRun).toHaveBeenCalledTimes(1);
  });

  test("keeps a generic error stop when the run has failed", async () => {
    const streamRunMessages = mock(async () =>
      stream([stop("run-1", 3, "end_turn")]),
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "failed",
        stop_reason: "error",
        metadata: { error: { detail: "provider rejected" } },
      })),
    } as unknown as Backend);

    const result = await drain(
      stream([ping("run-1", 1), stop("run-1", 2, "error")]),
    );

    expect(result.stopReason).toBe("error");
    expect(streamRunMessages).not.toHaveBeenCalled();
  });

  test("stops retrying when polling shows the run failed", async () => {
    const streamRunMessages = mock(async () => {
      throw new Error("resume endpoint unavailable");
    });
    const retrieveRun = mock(async () => ({
      ...runningRun(),
      status: "failed" as const,
      stop_reason: "error" as const,
      metadata: { error: { detail: "provider rejected" } },
    }));
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun,
    } as unknown as Backend);

    const result = await drain(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
    );

    expect(result.stopReason).toBe("error");
    expect(streamRunMessages).toHaveBeenCalledTimes(1);
    expect(retrieveRun).toHaveBeenCalledTimes(1);
  });

  test("preserves the initial stream error after retries are exhausted", async () => {
    const streamRunMessages = mock(async () => {
      throw new Error("resume endpoint unavailable");
    });
    __testSetBackend({
      capabilities,
      streamRunMessages,
    } as unknown as Backend);

    const result = await drain(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
    );

    expect(result.stopReason).toBe("error");
    expect(result.fallbackError).toBe("initial stream disconnected");
    expect(streamRunMessages).toHaveBeenCalledTimes(3);
  });
});
