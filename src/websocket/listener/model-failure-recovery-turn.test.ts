import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { setConversationId, setCurrentAgentId } from "@/agent/context";
import { __testSetBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import type { LocalTransport } from "./transport";
import { handleIncomingMessage } from "./turn";
import type { IncomingMessage } from "./types";
import { __listenerWarmupTestUtils } from "./warmup";

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

function mockStream(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function errorStop(
  runId: string,
  errorInfo: {
    error_type?: string;
    message?: string;
    error_code?: string;
    detail?: string;
  },
): LettaStreamingResponse[] {
  return [
    {
      message_type: "error_message",
      run_id: runId,
      error_type: errorInfo.error_type,
      error_code: errorInfo.error_code,
      message: errorInfo.message,
      detail: errorInfo.detail,
    } as unknown as LettaStreamingResponse,
    {
      message_type: "stop_reason",
      run_id: runId,
      seq_id: 1,
      stop_reason: "error",
    } as LettaStreamingResponse,
  ];
}

function successStop(runId: string): LettaStreamingResponse[] {
  return [
    {
      message_type: "message",
      run_id: runId,
      seq_id: 1,
      message: {
        type: "assistant_message",
        content: "Turn completed successfully.",
      },
    } as unknown as LettaStreamingResponse,
    {
      message_type: "stop_reason",
      run_id: runId,
      seq_id: 2,
      stop_reason: "end_turn",
    } as LettaStreamingResponse,
  ];
}

describe("listener turn model failure recovery", () => {
  beforeEach(async () => {
    clearAvailableModelsCache();
    await settingsManager.initialize();
  });

  afterEach(() => {
    setCurrentAgentId(null);
    setConversationId(null);
    clearAvailableModelsCache();
    __testSetBackend(null);
  });

  const HI_LETTA = "chatgpt-hi-letta/gpt-5.6-astra";
  const ARI = "chatgpt-ari/gpt-5.6-astra";
  const JIN = "chatgpt-jin/gpt-5.6-astra";

  function createTestEnvironment(params: {
    models: string[];
    streamSequence: Stream<LettaStreamingResponse>[];
  }) {
    const transport = new MockTransport();
    const listener = createRuntime();
    const agentId = "agent-recovery-test";
    const conversationId = "conv-recovery-test";

    __listenerWarmupTestUtils.setWarmupDepsForTests({
      ensureMemfsSyncedForAgent: async () => false,
      ensureSecretsHydratedForAgent: async () => {},
    });

    const agent = {
      id: agentId,
      name: "RecoveryAgent",
      model: params.models[0] ?? HI_LETTA,
      llm_config: { context_window: 128_000 },
      model_settings: { reasoning_effort: "high" },
    };
    const conversation = {
      id: conversationId,
      model: params.models[0] ?? HI_LETTA,
      llm_config: { context_window: 128_000 },
      model_settings: { reasoning_effort: "high" },
    };

    const sentRequests: Array<{ conversationId: string; body: unknown }> = [];
    let streamIndex = 0;

    const backend = {
      capabilities: { localModelCatalog: false },
      async listModels() {
        return params.models.map((handle) => ({
          handle,
          provider_type: "chatgpt_oauth",
          provider_category: "byok",
          max_context_window: 128_000,
        }));
      },
      async retrieveAgent() {
        return agent;
      },
      async updateAgent(_id: string, update: Record<string, unknown>) {
        Object.assign(agent, update);
        return agent;
      },
      async retrieveConversation() {
        return conversation;
      },
      async updateConversation(_id: string, update: Record<string, unknown>) {
        Object.assign(conversation, update);
        return conversation;
      },
      async createConversationMessageStream(convId: string, body: unknown) {
        sentRequests.push({ conversationId: convId, body });
        const stream = params.streamSequence[streamIndex++];
        if (!stream) {
          throw new Error(`Unexpected stream call at index ${streamIndex - 1}`);
        }
        return stream;
      },
      async retrieveRun(runId: string) {
        return {
          id: runId,
          metadata: {},
        };
      },
    };

    __testSetBackend(backend as never);
    const runtime = getOrCreateScopedRuntime(listener, agentId, conversationId);

    const incoming: IncomingMessage = {
      type: "message",
      agentId,
      conversationId,
      messages: [{ role: "user", content: "Test message" }],
    };

    return {
      agent,
      conversation,
      transport,
      runtime,
      incoming,
      sentRequests,
    };
  }

  test("quota failure rotates to sibling, and subsequent auth failure rotates to another sibling", async () => {
    const stream1 = mockStream(
      errorStop("run-1", { error_code: "usage_limit_reached" }),
    );
    const stream2 = mockStream(
      errorStop("run-2", {
        error_type: "llm_authentication",
        message:
          "Failed to refresh ChatGPT OAuth token: refresh token is invalid or expired",
      }),
    );
    const stream3 = mockStream(successStop("run-3"));

    const env = createTestEnvironment({
      models: [HI_LETTA, ARI, JIN],
      streamSequence: [stream1, stream2, stream3],
    });

    await handleIncomingMessage(env.incoming, env.transport, env.runtime);

    expect(env.sentRequests).toHaveLength(3);
    const secondRequestBody = env.sentRequests[1]?.body as Record<
      string,
      unknown
    >;
    const thirdRequestBody = env.sentRequests[2]?.body as Record<
      string,
      unknown
    >;
    const secondOverride = secondRequestBody.override_model;
    const thirdOverride = thirdRequestBody.override_model;
    if (
      typeof secondOverride !== "string" ||
      typeof thirdOverride !== "string"
    ) {
      throw new Error("Expected sibling model overrides on both retries");
    }
    expect([ARI, JIN]).toContain(secondOverride);
    expect([ARI, JIN]).toContain(thirdOverride);
    expect(thirdOverride).not.toBe(secondOverride);

    // Verify conversation was updated to a healthy sibling
    expect([JIN, ARI]).toContain(env.conversation.model);

    // Verify notices were emitted
    const notices = env.transport.sent
      .map((s) => JSON.parse(s))
      .filter(
        (m) => m.type === "stream_delta" && m.delta?.message_type === "retry",
      )
      .map((m) => m.delta?.message);

    expect(
      notices.some((n) => n.includes("chatgpt-hi-letta hit its usage limit")),
    ).toBe(true);
    expect(notices.some((n) => n.includes("credentials expired"))).toBe(true);

    // Verify terminal event
    const terminal = env.transport.sent
      .map((s) => JSON.parse(s))
      .find((m) => m.type === "turn_finished");
    expect(terminal).toBeDefined();
    expect(terminal.stop_reason).toBe("end_turn");
  });

  test("quota failure rotates to sibling, and auth failure with no siblings falls back temporarily to Auto", async () => {
    const stream1 = mockStream(
      errorStop("run-1", { error_code: "usage_limit_reached" }),
    );
    const stream2 = mockStream(
      errorStop("run-2", {
        error_type: "llm_authentication",
        message:
          "Failed to refresh ChatGPT OAuth token: refresh token is invalid or expired",
      }),
    );
    const stream3 = mockStream(successStop("run-3"));

    const env = createTestEnvironment({
      models: [HI_LETTA, ARI],
      streamSequence: [stream1, stream2, stream3],
    });

    await handleIncomingMessage(env.incoming, env.transport, env.runtime);

    expect(env.sentRequests).toHaveLength(3);

    // The third send must use override_model: "letta/auto"
    const thirdRequestBody = env.sentRequests[2]?.body as Record<
      string,
      unknown
    >;
    expect(thirdRequestBody.override_model).toBe("letta/auto");

    // The persistent conversation model must NOT be permanently changed to letta/auto!
    expect(env.conversation.model).not.toBe("letta/auto");
    expect(env.conversation.model).toBe(ARI);

    // Scoped model settings are preserved
    expect(env.conversation.model_settings).toEqual({
      reasoning_effort: "high",
    });

    // Verify Auto fallback notice
    const notices = env.transport.sent
      .map((s) => JSON.parse(s))
      .filter(
        (m) => m.type === "stream_delta" && m.delta?.message_type === "retry",
      )
      .map((m) => m.delta?.message);

    expect(notices).toContain(
      "chatgpt-hi-letta hit its usage limit — switched to chatgpt-ari",
    );
    expect(notices).toContain(
      "The automatically selected ChatGPT account needs to reconnect; temporarily switching to Auto and continuing...",
    );

    // Verify terminal event was success
    const terminal = env.transport.sent
      .map((s) => JSON.parse(s))
      .find((m) => m.type === "turn_finished");
    expect(terminal).toBeDefined();
    expect(terminal.stop_reason).toBe("end_turn");
  });

  test("initial auth failure on starting account is terminal without rotating or switching to Auto", async () => {
    const stream1 = mockStream(
      errorStop("run-1", {
        error_type: "llm_authentication",
        message:
          "Failed to refresh ChatGPT OAuth token: refresh token is invalid or expired",
      }),
    );

    const env = createTestEnvironment({
      models: [HI_LETTA, ARI, JIN],
      streamSequence: [stream1],
    });

    await handleIncomingMessage(env.incoming, env.transport, env.runtime);

    // Only one send occurred (no auto-rotations)
    expect(env.sentRequests).toHaveLength(1);

    // Conversation model is unchanged
    expect(env.conversation.model).toBe(HI_LETTA);

    // Terminal event is error
    const terminal = env.transport.sent
      .map((s) => JSON.parse(s))
      .find((m) => m.type === "turn_finished");
    expect(terminal).toBeDefined();
    expect(terminal.stop_reason).toBe("error");
  });

  test("quota failure with no siblings falls back temporarily to Auto", async () => {
    const stream1 = mockStream(
      errorStop("run-1", { error_code: "usage_limit_reached" }),
    );
    const stream2 = mockStream(successStop("run-2"));

    const env = createTestEnvironment({
      models: [HI_LETTA],
      streamSequence: [stream1, stream2],
    });

    await handleIncomingMessage(env.incoming, env.transport, env.runtime);

    expect(env.sentRequests).toHaveLength(2);

    // The second send must use override_model: "letta/auto"
    const secondRequestBody = env.sentRequests[1]?.body as Record<
      string,
      unknown
    >;
    expect(secondRequestBody.override_model).toBe("letta/auto");

    // The persistent conversation model must NOT be permanently changed to letta/auto!
    expect(env.conversation.model).toBe(HI_LETTA);

    // Verify Auto fallback notice for quota
    const notices = env.transport.sent
      .map((s) => JSON.parse(s))
      .filter(
        (m) => m.type === "stream_delta" && m.delta?.message_type === "retry",
      )
      .map((m) => m.delta?.message);

    expect(notices).toContain(
      "Quota limit reached; temporarily switching to Auto and continuing...",
    );

    // Verify terminal event was success
    const terminal = env.transport.sent
      .map((s) => JSON.parse(s))
      .find((m) => m.type === "turn_finished");
    expect(terminal).toBeDefined();
    expect(terminal.stop_reason).toBe("end_turn");
  });
});
