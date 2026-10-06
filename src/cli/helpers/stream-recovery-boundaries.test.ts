import { afterEach, expect, mock, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend, type Backend } from "@/backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import {
  type CurrentPendingApprovalLoader,
  revalidateRecoveredApprovals,
} from "@/cli/helpers/stream-approval-recovery";
import { retrieveRunForResume } from "@/cli/helpers/stream-resume";

const capabilities = {
  remoteMemfs: false,
  serverSideToolManagement: false,
  serverSecrets: false,
  promptRecompile: false,
  byokProviderRefresh: false,
  localModelCatalog: true,
  localMemfs: false,
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

function approval(runId: string, seqId: number): LettaStreamingResponse {
  return {
    message_type: "approval_request_message",
    id: "message-tool-approval-1",
    run_id: runId,
    seq_id: seqId,
    tool_call: {
      tool_call_id: "tool-approval-1",
      name: "exec_command",
      arguments: '{"cmd":"git status"}',
    },
  } as unknown as LettaStreamingResponse;
}

function stop(runId: string, seqId: number): LettaStreamingResponse {
  return {
    message_type: "stop_reason",
    run_id: runId,
    seq_id: seqId,
    stop_reason: "requires_approval",
  } as LettaStreamingResponse;
}

function approvalRequest() {
  return {
    toolCallId: "tool-approval-1",
    toolName: "exec_command",
    toolArgs: '{"cmd":"git status"}',
    messageId: "message-tool-approval-1",
  };
}

async function drain(
  initialStream: Stream<LettaStreamingResponse>,
  buffers = createBuffers("agent-1"),
  loadCurrentPendingApprovals: CurrentPendingApprovalLoader = async (
    _context,
    recovered,
  ) => recovered,
  abortSignal = new AbortController().signal,
) {
  return drainStreamWithResume(
    initialStream,
    buffers,
    () => {},
    abortSignal,
    undefined,
    undefined,
    undefined,
    undefined,
    { initialDelayMs: 0, maxAttempts: 1, maxDelayMs: 0 },
    loadCurrentPendingApprovals,
  );
}

afterEach(() => {
  __testSetBackend(null);
});

test("approval revalidation is interruptible by turn cancellation", async () => {
  const streamRunMessages = mock(async () => stream([stop("run-1", 3)]));
  __testSetBackend({ capabilities, streamRunMessages } as unknown as Backend);
  const buffers = createBuffers("agent-1");
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const loadCurrentPendingApprovals = mock(async () => {
    markStarted?.();
    return await new Promise<never>(() => {});
  });

  const resultPromise = drain(
    stream(
      [ping("run-1", 1), approval("run-1", 2)],
      new Error("initial stream disconnected"),
    ),
    buffers,
    loadCurrentPendingApprovals,
    controller.signal,
  );
  await started;
  controller.abort();
  const result = await resultPromise;

  expect(result.stopReason).toBe("error");
  expect(result.approvals).toEqual([]);
  expect(result.approval).toBeNull();
  expect(buffers.approvalsPending).toBe(false);
});

test("approval revalidation fails closed after its timeout", async () => {
  const result = await revalidateRecoveredApprovals({
    recoveredApprovals: [approvalRequest()],
    context: undefined,
    loadCurrentPendingApprovals: async () => await new Promise<never>(() => {}),
    timeoutMs: 1,
  });

  expect(result).toEqual([]);
});

test("run status reconciliation is interruptible after clean replay EOF", async () => {
  const streamRunMessages = mock(async () => stream([]));
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const retrieveRun = mock(
    async (_runId: string, _options?: { signal?: AbortSignal }) => {
      markStarted?.();
      return await new Promise<never>(() => {});
    },
  );
  __testSetBackend({
    capabilities,
    streamRunMessages,
    retrieveRun,
  } as unknown as Backend);
  const controller = new AbortController();

  const resultPromise = drain(
    stream([ping("run-1", 1)], new Error("initial stream disconnected")),
    createBuffers("agent-1"),
    async (_context, recovered) => recovered,
    controller.signal,
  );
  await started;
  controller.abort();
  const result = await resultPromise;

  expect(result.stopReason).toBe("error");
  expect(retrieveRun).toHaveBeenCalledTimes(1);
  expect(retrieveRun.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

test("run status reconciliation aborts its backend read on timeout", async () => {
  const retrieveRun = mock(
    async (_runId: string, _options?: { signal?: AbortSignal }) =>
      await new Promise<never>(() => {}),
  );
  const backend = { retrieveRun } as unknown as Backend;

  await expect(
    retrieveRunForResume(
      backend,
      "run-1",
      undefined,
      new AbortController().signal,
      1,
    ),
  ).rejects.toThrow("timed out");
  expect(retrieveRun.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

test("failed candidate status reconciliation is not immediately repeated", async () => {
  const streamRunMessages = mock(async () => stream([]));
  const retrieveRun = mock(async () => {
    throw new Error("status lookup failed");
  });
  __testSetBackend({
    capabilities,
    streamRunMessages,
    retrieveRun,
  } as unknown as Backend);

  const result = await drain(
    stream([ping("run-1", 1)], new Error("initial stream disconnected")),
  );

  expect(result.stopReason).toBe("error");
  expect(retrieveRun).toHaveBeenCalledTimes(1);
});

test("production revalidation supports named agentless conversations", async () => {
  const retrieveConversation = mock(async () => ({
    id: "conv-agentless",
    agent_id: null,
    in_context_message_ids: ["message-tool-approval-1"],
  }));
  const retrieveMessage = mock(async () => [approval("run-1", 2) as unknown]);
  const retrieveAgent = mock(async () => {
    throw new Error("agent lookup must not run");
  });
  __testSetBackend({
    capabilities,
    retrieveConversation,
    retrieveMessage,
    retrieveAgent,
  } as unknown as Backend);
  const recovered = approvalRequest();

  const result = await revalidateRecoveredApprovals({
    recoveredApprovals: [recovered],
    context: {
      conversationId: "conv-agentless",
      resolvedConversationId: "conv-agentless",
      agentId: null,
      requestStartedAtMs: 0,
    },
  });

  expect(result).toEqual([recovered]);
  expect(retrieveConversation).toHaveBeenCalledTimes(1);
  expect(retrieveMessage).toHaveBeenCalledTimes(1);
  expect(retrieveAgent).not.toHaveBeenCalled();
});
