import { afterEach, describe, expect, mock, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type {
  LettaStreamingResponse,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend, type Backend } from "@/backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import type { CurrentPendingApprovalLoader } from "@/cli/helpers/stream-approval-recovery";
import type { StreamResumePolicy } from "@/cli/helpers/stream-resume";

const capabilities = {
  remoteMemfs: false,
  serverSideToolManagement: false,
  serverSecrets: false,
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

function approval(
  runId: string,
  seqId: number,
  toolArgs = '{"cmd":"git status"}',
  toolCallId = "tool-approval-1",
): LettaStreamingResponse {
  return {
    message_type: "approval_request_message",
    id: `message-${toolCallId}`,
    run_id: runId,
    seq_id: seqId,
    tool_call: {
      tool_call_id: toolCallId,
      name: "exec_command",
      arguments: toolArgs,
    },
  } as unknown as LettaStreamingResponse;
}

function approvalRequest(toolCallId: string) {
  return {
    toolCallId,
    toolName: "exec_command",
    toolArgs: '{"cmd":"git status"}',
    messageId: `message-${toolCallId}`,
  };
}

function toolReturn(
  runId: string,
  seqId: number,
  toolCallId = "tool-approval-1",
): LettaStreamingResponse {
  return {
    message_type: "tool_return_message",
    run_id: runId,
    seq_id: seqId,
    tool_call_id: toolCallId,
    status: "success",
    tool_return: "done",
  } as unknown as LettaStreamingResponse;
}

function parallelToolReturn(
  runId: string,
  seqId: number,
  toolCallIds: string[],
): LettaStreamingResponse {
  return {
    message_type: "tool_return_message",
    run_id: runId,
    seq_id: seqId,
    tool_returns: toolCallIds.map((toolCallId) => ({
      tool_call_id: toolCallId,
      status: "success",
      tool_return: "done",
    })),
  } as unknown as LettaStreamingResponse;
}

function stop(
  runId: string,
  seqId: number,
  stopReason: "end_turn" | "error" | "llm_api_error" | "requires_approval",
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

async function drain(
  initialStream: Stream<LettaStreamingResponse>,
  policy = immediateRetries,
  buffers = createBuffers("agent-1"),
  loadCurrentPendingApprovals: CurrentPendingApprovalLoader = async (
    _context,
    recovered,
  ) => recovered,
) {
  return drainStreamWithResume(
    initialStream,
    buffers,
    () => {},
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    policy,
    loadCurrentPendingApprovals,
  );
}

async function drainSuccessfulSplitApprovalReplay(
  currentApprovals: ReturnType<typeof approvalRequest>[],
) {
  const streamRunMessages = mock(async () =>
    stream([
      approval("run-1", 3, '{"cmd":"pwd"}', "tool-approval-2"),
      stop("run-1", 4, "requires_approval"),
    ]),
  );
  __testSetBackend({ capabilities, streamRunMessages } as unknown as Backend);
  const buffers = createBuffers("agent-1");
  const loadCurrentPendingApprovals = mock(async () => currentApprovals);
  const result = await drain(
    stream(
      [ping("run-1", 1), approval("run-1", 2)],
      new Error("initial stream disconnected"),
    ),
    immediateRetries,
    buffers,
    loadCurrentPendingApprovals,
  );
  return { result, buffers, loadCurrentPendingApprovals };
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

  test("recovers a generic error stop when current state confirms the approval", async () => {
    const streamRunMessages = mock(async () => {
      throw new Error("resume endpoint unavailable");
    });
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "completed" as const,
        stop_reason: "requires_approval" as const,
      })),
    } as unknown as Backend);
    const buffers = createBuffers("agent-1");

    const result = await drain(
      stream([
        ping("run-1", 1),
        approval("run-1", 2),
        stop("run-1", 3, "error"),
      ]),
      immediateRetries,
      buffers,
    );

    expect(result.stopReason).toBe("requires_approval");
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "ready",
    });
  });

  test("retains pre-replay approval state when the next status lookup fails", async () => {
    const streamRunMessages = mock(async () => {
      throw new Error("resume endpoint unavailable");
    });
    let retrieveCount = 0;
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => {
        retrieveCount += 1;
        if (retrieveCount > 1) throw new Error("status endpoint unavailable");
        return {
          ...runningRun(),
          status: "completed" as const,
          stop_reason: "requires_approval" as const,
        };
      }),
    } as unknown as Backend);
    const buffers = createBuffers("agent-1");

    const result = await drain(
      stream([
        ping("run-1", 1),
        approval("run-1", 2),
        stop("run-1", 3, "error"),
      ]),
      immediateRetries,
      buffers,
    );

    expect(result.stopReason).toBe("requires_approval");
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "ready",
    });
  });

  test("unions approval IDs split across a successful replay", async () => {
    const { result, buffers, loadCurrentPendingApprovals } =
      await drainSuccessfulSplitApprovalReplay([
        approvalRequest("tool-approval-1"),
        approvalRequest("tool-approval-2"),
      ]);

    expect(loadCurrentPendingApprovals).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("requires_approval");
    expect(result.approvals?.map((item) => item.toolCallId)).toEqual([
      "tool-approval-1",
      "tool-approval-2",
    ]);
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "ready",
    });
    expect(buffers.byId.get("tool-approval-2")).toMatchObject({
      phase: "ready",
    });
  });

  test.each([
    ["empty", []],
    ["subset", [approvalRequest("tool-approval-1")]],
    [
      "superset",
      [
        approvalRequest("tool-approval-1"),
        approvalRequest("tool-approval-2"),
        approvalRequest("tool-approval-3"),
      ],
    ],
  ])(
    "fails closed when current state has a %s batch after successful replay",
    async (_caseName, currentApprovals) => {
      const { result, buffers, loadCurrentPendingApprovals } =
        await drainSuccessfulSplitApprovalReplay(currentApprovals);

      expect(loadCurrentPendingApprovals).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe("error");
      expect(result.approvals).toEqual([]);
      expect(buffers.byId.get("tool-approval-1")).toMatchObject({
        phase: "finished",
        resultText: "Stream error",
      });
      expect(buffers.byId.get("tool-approval-2")).toMatchObject({
        phase: "finished",
        resultText: "Stream error",
      });
    },
  );

  test("preserves end_turn when replay resolves the original approval", async () => {
    const streamRunMessages = mock(async () =>
      stream([toolReturn("run-1", 3), stop("run-1", 4, "end_turn")]),
    );
    __testSetBackend({ capabilities, streamRunMessages } as unknown as Backend);
    const buffers = createBuffers("agent-1");
    const loadCurrentPendingApprovals = mock(async () => []);

    const result = await drain(
      stream(
        [ping("run-1", 1), approval("run-1", 2)],
        new Error("initial stream disconnected"),
      ),
      immediateRetries,
      buffers,
      loadCurrentPendingApprovals,
    );

    expect(loadCurrentPendingApprovals).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("end_turn");
    expect(result.approvals).toEqual([]);
    expect(result.approval).toBeNull();
    expect(result.fallbackError).toBeNull();
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "finished",
      resultOk: true,
      resultText: "done",
    });
  });

  test("revalidates only unresolved approvals after a partial replay resolution", async () => {
    const streamRunMessages = mock(async () =>
      stream([toolReturn("run-1", 4), stop("run-1", 5, "end_turn")]),
    );
    __testSetBackend({ capabilities, streamRunMessages } as unknown as Backend);
    const buffers = createBuffers("agent-1");
    const loadCurrentPendingApprovals = mock(async () => [
      approvalRequest("tool-approval-2"),
    ]);

    const result = await drain(
      stream(
        [
          ping("run-1", 1),
          approval("run-1", 2),
          approval("run-1", 3, '{"cmd":"pwd"}', "tool-approval-2"),
        ],
        new Error("initial stream disconnected"),
      ),
      immediateRetries,
      buffers,
      loadCurrentPendingApprovals,
    );

    expect(loadCurrentPendingApprovals).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("requires_approval");
    expect(result.approvals?.map((item) => item.toolCallId)).toEqual([
      "tool-approval-2",
    ]);
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "finished",
      resultOk: true,
      resultText: "done",
    });
    expect(buffers.byId.get("tool-approval-2")).toMatchObject({
      phase: "ready",
    });
  });

  test("failed replay recovers only approvals not resolved by tool returns", async () => {
    const streamRunMessages = mock(async () =>
      stream(
        [toolReturn("run-1", 4)],
        new Error("resumed stream disconnected"),
      ),
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "completed" as const,
        stop_reason: "requires_approval" as const,
      })),
    } as unknown as Backend);
    const buffers = createBuffers("agent-1");
    const loadCurrentPendingApprovals = mock(async () => [
      approvalRequest("tool-approval-2"),
    ]);

    const result = await drain(
      stream(
        [
          ping("run-1", 1),
          approval("run-1", 2),
          approval("run-1", 3, '{"cmd":"pwd"}', "tool-approval-2"),
        ],
        new Error("initial stream disconnected"),
      ),
      { ...immediateRetries, maxAttempts: 1 },
      buffers,
      loadCurrentPendingApprovals,
    );

    expect(loadCurrentPendingApprovals).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("requires_approval");
    expect(result.approvals?.map((item) => item.toolCallId)).toEqual([
      "tool-approval-2",
    ]);
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "finished",
      resultOk: true,
      resultText: "done",
    });
    expect(buffers.byId.get("tool-approval-2")).toMatchObject({
      phase: "ready",
    });
  });

  test("terminal replay errors do not reconstruct stale approval rows", async () => {
    const streamRunMessages = mock(async () =>
      stream([stop("run-1", 3, "llm_api_error")]),
    );
    __testSetBackend({ capabilities, streamRunMessages } as unknown as Backend);
    const buffers = createBuffers("agent-1");
    const loadCurrentPendingApprovals = mock(async () => []);

    const result = await drain(
      stream(
        [ping("run-1", 1), approval("run-1", 2)],
        new Error("initial stream disconnected"),
      ),
      immediateRetries,
      buffers,
      loadCurrentPendingApprovals,
    );

    expect(loadCurrentPendingApprovals).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("llm_api_error");
    expect(result.approvals).toEqual([]);
    expect(result.approval).toBeNull();
    expect(buffers.byId.has("tool-approval-1")).toBe(false);
    expect(buffers.approvalsPending).toBe(false);
  });

  test("plural tool returns retain only replay approvals still pending", async () => {
    const streamRunMessages = mock(async () =>
      stream([
        approval("run-1", 2),
        approval("run-1", 3, '{"cmd":"pwd"}', "tool-approval-2"),
        parallelToolReturn("run-1", 4, ["tool-approval-1"]),
        stop("run-1", 5, "requires_approval"),
      ]),
    );
    __testSetBackend({ capabilities, streamRunMessages } as unknown as Backend);
    const buffers = createBuffers("agent-1");
    const loadCurrentPendingApprovals = mock(async () => [
      approvalRequest("tool-approval-2"),
    ]);

    const result = await drain(
      stream([ping("run-1", 1)], new Error("initial stream disconnected")),
      immediateRetries,
      buffers,
      loadCurrentPendingApprovals,
    );

    expect(loadCurrentPendingApprovals).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("requires_approval");
    expect(result.approvals?.map((item) => item.toolCallId)).toEqual([
      "tool-approval-2",
    ]);
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "finished",
      resultOk: true,
      resultText: "done",
    });
    expect(buffers.byId.get("tool-approval-2")).toMatchObject({
      phase: "ready",
    });
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

  test("preserves an approval boundary when replay misses the settled run", async () => {
    const streamRunMessages = mock(async () => {
      throw new APIError(
        400,
        {
          detail:
            "Error occurred while trying to proxy: No active runs found for this conversation.",
        },
        undefined,
        new Headers(),
      );
    });
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "completed" as const,
        stop_reason: "requires_approval" as const,
      })),
    } as unknown as Backend);

    const result = await drain(
      stream(
        [ping("run-1", 1), approval("run-1", 2)],
        new Error("initial stream disconnected"),
      ),
    );

    expect(result.stopReason).toBe("requires_approval");
    expect(result.fallbackError).toBeNull();
    expect(result.approvals).toEqual([
      {
        toolCallId: "tool-approval-1",
        toolName: "exec_command",
        toolArgs: '{"cmd":"git status"}',
        messageId: "message-tool-approval-1",
      },
    ]);
    expect(streamRunMessages).toHaveBeenCalledTimes(3);
  });

  test("does not revive an approval after the run failed", async () => {
    const streamRunMessages = mock(async () => {
      throw new Error("resume endpoint unavailable");
    });
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "failed" as const,
        stop_reason: "error" as const,
      })),
    } as unknown as Backend);

    const result = await drain(
      stream(
        [ping("run-1", 1), approval("run-1", 2)],
        new Error("initial stream disconnected"),
      ),
    );

    expect(result.stopReason).toBe("error");
    expect(streamRunMessages).toHaveBeenCalledTimes(1);
  });

  test("keeps approval chunks merged from a failed replay", async () => {
    const streamRunMessages = mock(async () => {
      if (streamRunMessages.mock.calls.length === 1) {
        return stream(
          [approval("run-1", 3, ' status"}')],
          new Error("resumed stream disconnected"),
        );
      }
      throw new Error("resume endpoint unavailable");
    });
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "completed" as const,
        stop_reason: "requires_approval" as const,
      })),
    } as unknown as Backend);

    const result = await drain(
      stream(
        [ping("run-1", 1), approval("run-1", 2, '{"cmd":"git')],
        new Error("initial stream disconnected"),
      ),
    );

    expect(result.stopReason).toBe("requires_approval");
    expect(result.approvals).toEqual([
      {
        toolCallId: "tool-approval-1",
        toolName: "exec_command",
        toolArgs: '{"cmd":"git status"}',
        messageId: "message-tool-approval-1",
      },
    ]);
  });

  test("recovers an approval when the only replay disconnects during iteration", async () => {
    const streamRunMessages = mock(async () =>
      stream([], new Error("resumed stream disconnected")),
    );
    const retrieveRun = mock(async () => ({
      ...runningRun(),
      status: "completed" as const,
      stop_reason: "requires_approval" as const,
    }));
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun,
    } as unknown as Backend);

    const buffers = createBuffers("agent-1");
    const result = await drain(
      stream(
        [ping("run-1", 1), approval("run-1", 2)],
        new Error("initial stream disconnected"),
      ),
      { ...immediateRetries, maxAttempts: 1 },
      buffers,
    );

    expect(result.stopReason).toBe("requires_approval");
    expect(retrieveRun).toHaveBeenCalledTimes(1);
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "ready",
    });
  });

  test("does not recover an approval already resolved in current conversation state", async () => {
    const streamRunMessages = mock(async () =>
      stream([], new Error("resumed stream disconnected")),
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "completed" as const,
        stop_reason: "requires_approval" as const,
      })),
    } as unknown as Backend);
    const buffers = createBuffers("agent-1");
    const loadCurrentPendingApprovals = mock(async () => []);

    const result = await drain(
      stream(
        [ping("run-1", 1), approval("run-1", 2)],
        new Error("initial stream disconnected"),
      ),
      { ...immediateRetries, maxAttempts: 1 },
      buffers,
      loadCurrentPendingApprovals,
    );

    expect(loadCurrentPendingApprovals).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("error");
    expect(result.approvals).toEqual([]);
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "finished",
      resultOk: false,
      resultText: "Stream error",
    });
  });

  test("fails closed when the stream missed part of the current approval batch", async () => {
    const streamRunMessages = mock(async () =>
      stream([], new Error("resumed stream disconnected")),
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "completed" as const,
        stop_reason: "requires_approval" as const,
      })),
    } as unknown as Backend);
    const buffers = createBuffers("agent-1");

    const result = await drain(
      stream(
        [ping("run-1", 1), approval("run-1", 2)],
        new Error("initial stream disconnected"),
      ),
      { ...immediateRetries, maxAttempts: 1 },
      buffers,
      async () => [
        approvalRequest("tool-approval-1"),
        approvalRequest("tool-approval-2"),
      ],
    );

    expect(result.stopReason).toBe("error");
    expect(result.approvals).toEqual([]);
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "finished",
      resultText: "Stream error",
    });
  });

  test("fails closed when current state has resolved part of the recovered batch", async () => {
    const streamRunMessages = mock(async () =>
      stream([], new Error("resumed stream disconnected")),
    );
    __testSetBackend({
      capabilities,
      streamRunMessages,
      retrieveRun: mock(async () => ({
        ...runningRun(),
        status: "completed" as const,
        stop_reason: "requires_approval" as const,
      })),
    } as unknown as Backend);
    const buffers = createBuffers("agent-1");

    const result = await drain(
      stream(
        [
          ping("run-1", 1),
          approval("run-1", 2),
          approval("run-1", 3, '{"cmd":"pwd"}', "tool-approval-2"),
        ],
        new Error("initial stream disconnected"),
      ),
      { ...immediateRetries, maxAttempts: 1 },
      buffers,
      async () => [approvalRequest("tool-approval-1")],
    );

    expect(result.stopReason).toBe("error");
    expect(result.approvals).toEqual([]);
    expect(buffers.byId.get("tool-approval-1")).toMatchObject({
      phase: "finished",
      resultText: "Stream error",
    });
    expect(buffers.byId.get("tool-approval-2")).toMatchObject({
      phase: "finished",
      resultText: "Stream error",
    });
  });
});
