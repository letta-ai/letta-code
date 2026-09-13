import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { __testSetBackend, type Backend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { prepareToolExecutionContextForScope } from "./toolset";

const AGENT_ID = "agent-provider-resolution";
const CONVERSATION_ID = "conv-provider-resolution";
const CHATGPT_ALIAS = "chatgpt-jin/gpt-5.6-sol-fast";

class ProviderResolutionBackend extends FakeHeadlessBackend {
  agent: AgentState = {
    id: AGENT_ID,
    name: "Provider Resolution Agent",
    model: "anthropic/claude-sonnet-4-6",
    model_settings: { provider_type: "anthropic" },
  } as AgentState;

  conversation: Conversation = {
    id: CONVERSATION_ID,
    agent_id: AGENT_ID,
  } as Conversation;

  models: Array<Record<string, unknown>> = [];
  listModelsCalls = 0;
  listModelsError: Error | null = null;

  override async retrieveAgent(): Promise<AgentState> {
    return this.agent;
  }

  override async retrieveConversation(): Promise<Conversation> {
    return this.conversation;
  }

  override async listModels(): ReturnType<Backend["listModels"]> {
    this.listModelsCalls += 1;
    if (this.listModelsError) throw this.listModelsError;
    return this.models as unknown as Awaited<ReturnType<Backend["listModels"]>>;
  }
}

function modelCarrier(
  model: string,
  providerType?: string,
): Pick<AgentState, "id" | "name" | "model" | "model_settings"> {
  return {
    id: AGENT_ID,
    name: "Provider Resolution Agent",
    model,
    ...(providerType
      ? { model_settings: { provider_type: providerType } }
      : {}),
  } as Pick<AgentState, "id" | "name" | "model" | "model_settings">;
}

describe("scoped toolset provider resolution", () => {
  let backend: ProviderResolutionBackend;

  beforeEach(() => {
    clearAvailableModelsCache();
    backend = new ProviderResolutionBackend();
    __testSetBackend(backend);
  });

  afterEach(() => {
    clearAvailableModelsCache();
    __testSetBackend(null);
  });

  test("keeps the agent provider when an explicit model is the same custom alias", async () => {
    backend.agent = modelCarrier(CHATGPT_ALIAS, "chatgpt_oauth") as AgentState;
    backend.listModelsError = new Error("catalog unavailable");

    const prepared = await prepareToolExecutionContextForScope({
      agentId: AGENT_ID,
      conversationId: "default",
      overrideModel: CHATGPT_ALIAS,
    });

    expect(prepared.toolset).toBe("codex");
    expect(backend.listModelsCalls).toBe(0);
  });

  test("keeps the agent provider when a cached model is the same custom alias", async () => {
    backend.agent = modelCarrier(CHATGPT_ALIAS, "chatgpt_oauth") as AgentState;
    backend.listModelsError = new Error("catalog unavailable");

    const prepared = await prepareToolExecutionContextForScope({
      agentId: AGENT_ID,
      conversationId: "default",
      cachedEffectiveModel: CHATGPT_ALIAS,
    });

    expect(prepared.toolset).toBe("codex");
    expect(backend.listModelsCalls).toBe(0);
  });

  test("uses catalog metadata for a conversation model without stored provider data", async () => {
    backend.conversation = {
      id: CONVERSATION_ID,
      agent_id: AGENT_ID,
      model: CHATGPT_ALIAS,
    } as Conversation;
    backend.models = [
      { handle: CHATGPT_ALIAS, provider_type: "chatgpt_oauth" },
    ];

    const prepared = await prepareToolExecutionContextForScope({
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
    });

    expect(prepared.toolset).toBe("codex");
    expect(backend.listModelsCalls).toBe(1);
  });

  test("does not carry a ChatGPT agent provider into an Anthropic conversation", async () => {
    backend.agent = modelCarrier(CHATGPT_ALIAS, "chatgpt_oauth") as AgentState;
    backend.conversation = {
      id: CONVERSATION_ID,
      agent_id: AGENT_ID,
      model: "anthropic/claude-sonnet-4-6",
    } as Conversation;
    backend.models = [
      {
        handle: "anthropic/claude-sonnet-4-6",
        provider_type: "anthropic",
      },
    ];

    const prepared = await prepareToolExecutionContextForScope({
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
    });

    expect(prepared.toolset).toBe("default");
    expect(backend.listModelsCalls).toBe(1);
  });

  test("uses a stored conversation provider without reading inventory", async () => {
    backend.conversation = {
      id: CONVERSATION_ID,
      agent_id: AGENT_ID,
      model: CHATGPT_ALIAS,
      model_settings: { provider_type: "chatgpt_oauth" },
    } as Conversation;
    backend.listModelsError = new Error("catalog must not be read");

    const prepared = await prepareToolExecutionContextForScope({
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
    });

    expect(prepared.toolset).toBe("codex");
    expect(backend.listModelsCalls).toBe(0);
  });

  test("keeps the conversation provider when an explicit model matches it", async () => {
    backend.conversation = {
      id: CONVERSATION_ID,
      agent_id: AGENT_ID,
      model: CHATGPT_ALIAS,
      model_settings: { provider_type: "chatgpt_oauth" },
    } as Conversation;
    backend.listModelsError = new Error("catalog must not be read");

    const prepared = await prepareToolExecutionContextForScope({
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      overrideModel: CHATGPT_ALIAS,
    });

    expect(prepared.toolset).toBe("codex");
    expect(backend.listModelsCalls).toBe(0);
  });

  test("does not read inventory for a manual toolset", async () => {
    backend.agent = modelCarrier(CHATGPT_ALIAS) as AgentState;
    backend.listModelsError = new Error("catalog must not be read");

    const prepared = await prepareToolExecutionContextForScope({
      agentId: AGENT_ID,
      conversationId: "default",
      clientToolset: { base: "default" },
    });

    expect(prepared.toolset).toBe("default");
    expect(backend.listModelsCalls).toBe(0);
  });
});
