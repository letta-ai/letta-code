import { afterEach, describe, expect, mock, test } from "bun:test";
import { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { fetchRunErrorInfo } from "@/agent/approval-recovery";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { rotateChatGPTPlanOnQuotaLimit } from "@/agent/chatgpt-plan-rotation";
import { __testSetBackend, type Backend } from "@/backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStream, drainStreamWithResume } from "@/cli/helpers/stream";

const RUN_ID = "run-quota-recovery";
const PRIMARY_HANDLE = "chatgpt-primary/gpt-6-astra";
const SIBLING_HANDLE = "chatgpt-sibling/gpt-6-astra";
const quotaError = {
  message_type: "error_message",
  error_type: "llm_insufficient_credits",
  message: "ChatGPT rate limit exceeded: The usage limit has been reached",
  detail:
    'ChatGPT rate limit exceeded: {"error":{"type":"usage_limit_reached","plan_type":"pro","resets_at":1800000000}}',
  error_code: "usage_limit_reached",
  kind: "insufficient_credits",
  provider: "chatgpt_oauth",
  retryable: false,
  run_id: RUN_ID,
  seq_id: null,
};

function fromSse(error: typeof quotaError, event = "error") {
  const wire =
    `data: ${JSON.stringify({
      message_type: "stop_reason",
      stop_reason: "insufficient_credits",
      run_id: RUN_ID,
    })}\n\n` +
    `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(error)}\n\n`;
  return Stream.fromSSEResponse<LettaStreamingResponse>(
    new Response(wire),
    new AbortController(),
  );
}

function installBackend(overrides: Partial<Backend> = {}) {
  const conversation = { id: "conv-quota", model: PRIMARY_HANDLE };
  const updateConversation = mock(
    async (_id: string, update: { model?: string }) => {
      Object.assign(conversation, update);
      return conversation;
    },
  );
  // Keep final error persistence unavailable for the entire test. Recovery
  // must use the stream, not win a race against a timer or another API read.
  const retrieveRun = mock(async () => ({
    id: RUN_ID,
    status: "running",
    metadata: {},
  }));
  __testSetBackend({
    capabilities: { localModelCatalog: false },
    retrieveRun,
    retrieveConversation: async () => conversation,
    updateConversation,
    listModels: async () =>
      [PRIMARY_HANDLE, SIBLING_HANDLE].map((handle) => ({
        handle,
        provider_type: "chatgpt_oauth",
        provider_category: "byok",
        max_context_window: 1_050_000,
      })),
    ...overrides,
  } as unknown as Backend);
  return { conversation, updateConversation };
}

afterEach(() => {
  clearAvailableModelsCache();
  __testSetBackend(null);
});

describe("SSE quota errors through stream recovery", () => {
  for (const event of ["error", ""]) {
    test(`rotates from ${event ? "event: error" : "data-only error"} without saved run metadata`, async () => {
      const { conversation, updateConversation } = installBackend();
      const result = await drainStreamWithResume(
        fromSse(quotaError, event),
        createBuffers("agent-quota"),
        () => {},
        new AbortController().signal,
      );
      const runErrorInfo = await fetchRunErrorInfo(RUN_ID);
      expect(runErrorInfo).toBeNull();

      const rotation = await rotateChatGPTPlanOnQuotaLimit({
        agentId: "agent-quota",
        conversationId: conversation.id,
        currentHandle: null,
        error: result.errorInfo ?? runErrorInfo ?? result.fallbackError,
        exhaustedProviders: new Set(),
      });

      expect(rotation?.toHandle).toBe(SIBLING_HANDLE);
      expect(rotation?.resetsAt).toBe(1_800_000_000_000);
      expect(conversation.model).toBe(SIBLING_HANDLE);
      expect(updateConversation).toHaveBeenCalledTimes(1);
      expect(result.stopReason).toBe("insufficient_credits");
      expect(result.lastRunId).toBe(RUN_ID);
      expect(result.errorInfo?.error_code).toBe("usage_limit_reached");
    });
  }

  test("does not rotate a temporary rate limit", async () => {
    const { conversation, updateConversation } = installBackend();
    const result = await drainStreamWithResume(
      fromSse({
        ...quotaError,
        error_code: "rate_limit_exceeded",
        message: "Please slow down and retry later.",
        detail: "Too many requests",
      }),
      createBuffers("agent-quota"),
      () => {},
      new AbortController().signal,
    );
    const rotation = await rotateChatGPTPlanOnQuotaLimit({
      agentId: "agent-quota",
      conversationId: conversation.id,
      currentHandle: null,
      error: result.errorInfo ?? result.fallbackError,
      exhaustedProviders: new Set(),
    });

    expect(result.errorInfo?.error_code).toBe("rate_limit_exceeded");
    expect(rotation).toBeNull();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("uses the quota code even when the error detail contains no JSON", async () => {
    const { conversation, updateConversation } = installBackend();
    const result = await drainStreamWithResume(
      fromSse({ ...quotaError, detail: "ChatGPT rate limit exceeded:" }),
      createBuffers("agent-quota"),
      () => {},
      new AbortController().signal,
    );
    const rotation = await rotateChatGPTPlanOnQuotaLimit({
      agentId: "agent-quota",
      conversationId: conversation.id,
      currentHandle: null,
      error: result.errorInfo,
      exhaustedProviders: new Set(),
    });

    expect(rotation?.toHandle).toBe(SIBLING_HANDLE);
    expect(rotation?.resetsAt).toBeNull();
    expect(updateConversation).toHaveBeenCalledTimes(1);
  });

  test("does not carry the failed stream's error into a successful retry", async () => {
    const buffers = createBuffers("agent-quota");
    const failed = await drainStream(fromSse(quotaError), buffers, () => {});
    expect(failed.errorInfo?.error_code).toBe("usage_limit_reached");

    const retry = Stream.fromSSEResponse<LettaStreamingResponse>(
      new Response(
        'data: {"message_type":"stop_reason","stop_reason":"end_turn","run_id":"run-retry"}\n\ndata: [DONE]\n\n',
      ),
      new AbortController(),
    );
    const succeeded = await drainStream(retry, buffers, () => {});
    expect(succeeded.stopReason).toBe("end_turn");
    expect(succeeded.lastRunId).toBe("run-retry");
    expect(succeeded.errorInfo).toBeUndefined();
  });

  test("keeps generic SDK exceptions as text without inventing quota metadata", async () => {
    const stream = Stream.fromSSEResponse<LettaStreamingResponse>(
      new Response('event: error\ndata: {"message":"connection failed"}\n\n'),
      new AbortController(),
    );
    const result = await drainStream(
      stream,
      createBuffers("agent-quota"),
      () => {},
    );
    expect(result.errorInfo).toBeUndefined();
    expect(result.fallbackError).toBe("connection failed");
    expect(result.stopReason).toBe("error");
  });

  test("returns the final SDK error rather than an earlier yielded error", async () => {
    const earlier = {
      ...quotaError,
      error_code: "rate_limit_exceeded",
      message: "Too many requests",
      detail: "Please retry later",
    };
    const stream = Stream.fromSSEResponse<LettaStreamingResponse>(
      new Response(
        `data: ${JSON.stringify(earlier)}\n\nevent: error\ndata: ${JSON.stringify(quotaError)}\n\n`,
      ),
      new AbortController(),
    );
    const callbackCodes: Array<string | undefined> = [];
    const result = await drainStream(
      stream,
      createBuffers("agent-quota"),
      () => {},
      undefined,
      undefined,
      ({ errorInfo }) => {
        if (errorInfo) callbackCodes.push(errorInfo.error_code);
        return undefined;
      },
    );
    expect(callbackCodes).toEqual(["rate_limit_exceeded"]);
    expect(result.errorInfo?.error_code).toBe("usage_limit_reached");
  });

  for (const completes of [false, true]) {
    test(`a reconnect ${completes ? "clears a prior quota error when it succeeds" : "preserves the quota error when it fails"}`, async () => {
      let resumes = 0;
      const { conversation, updateConversation } = installBackend({
        streamRunMessages: async () => {
          resumes++;
          return Stream.fromSSEResponse<LettaStreamingResponse>(
            new Response(
              resumes === 1
                ? `event: error\ndata: ${JSON.stringify(quotaError)}\n\n`
                : `data: {"message_type":"stop_reason","stop_reason":"end_turn","run_id":"${RUN_ID}"}\n\ndata: [DONE]\n\n`,
            ),
            new AbortController(),
          );
        },
      });
      const initial = Stream.fromSSEResponse<LettaStreamingResponse>(
        new Response(
          `data: {"message_type":"ping","run_id":"${RUN_ID}","seq_id":1}\n\nevent: error\ndata: {"message":"connection failed"}\n\n`,
        ),
        new AbortController(),
      );
      const result = await drainStreamWithResume(
        initial,
        createBuffers("agent-quota"),
        () => {},
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        undefined,
        { initialDelayMs: 0, maxDelayMs: 0, maxAttempts: completes ? 2 : 1 },
      );
      expect(resumes).toBe(completes ? 2 : 1);
      if (completes) {
        expect(result.stopReason).toBe("end_turn");
        expect(result.errorInfo).toBeUndefined();
      } else {
        const rotation = await rotateChatGPTPlanOnQuotaLimit({
          agentId: "agent-quota",
          conversationId: conversation.id,
          currentHandle: null,
          error: result.errorInfo,
          exhaustedProviders: new Set(),
        });
        expect(rotation?.toHandle).toBe(SIBLING_HANDLE);
        expect(updateConversation).toHaveBeenCalledTimes(1);
      }
    });
  }
});
