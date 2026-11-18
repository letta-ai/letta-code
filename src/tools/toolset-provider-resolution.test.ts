import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { prepareToolExecutionContextForScope } from "./toolset";

const AGENT_ID = "agent-provider-resolution";
const CONVERSATION_ID = "conv-provider-resolution";

class ProviderResolutionBackend extends FakeHeadlessBackend {
  retrieveConversationCalls = 0;

  override async retrieveConversation(): Promise<Conversation> {
    this.retrieveConversationCalls += 1;
    return { id: CONVERSATION_ID, agent_id: AGENT_ID } as Conversation;
  }
}

describe("scoped toolset provider resolution", () => {
  let backend: ProviderResolutionBackend;

  beforeEach(() => {
    backend = new ProviderResolutionBackend();
    __testSetBackend(backend);
  });

  afterEach(() => {
    __testSetBackend(null);
  });

  test("reuses conversation metadata fetched before reminder construction", async () => {
    const prepared = await prepareToolExecutionContextForScope({
      agentId: AGENT_ID,
      cachedAgent: {
        id: AGENT_ID,
        model: "anthropic/claude-sonnet-4-6",
      } as AgentState,
      conversationId: CONVERSATION_ID,
      cachedConversation: {
        id: CONVERSATION_ID,
        agent_id: AGENT_ID,
        model: "anthropic/claude-sonnet-4-6",
        model_settings: { provider_type: "anthropic" },
      } as Conversation,
    });
    expect(prepared.toolset).toBe("default");
    expect(backend.retrieveConversationCalls).toBe(0);
  });
});
