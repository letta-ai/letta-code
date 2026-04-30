import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  Backend,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  RunMessageStreamBody,
} from "../backend";

function createEmptyPage<T>() {
  return {
    getPaginatedItems: () => [] as T[],
  };
}

function createFakeStream(text: string): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "assistant_message",
        id: "msg-fake-assistant",
        content: [{ type: "text", text }],
      } as LettaStreamingResponse;
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

export class FakeHeadlessBackend implements Backend {
  private readonly agent: AgentState;
  private conversationId = "conv-fake-headless";

  constructor(agentId = "agent-fake-headless") {
    this.agent = {
      id: agentId,
      name: "Fake Headless Agent",
      tools: [],
      tags: [],
      message_ids: [],
      in_context_message_ids: [],
      llm_config: {
        model: "dev/fake-headless",
        model_endpoint_type: "openai",
        model_endpoint: "https://example.invalid/v1",
        context_window: 128000,
      },
    } as unknown as AgentState;
  }

  async retrieveAgent(agentId: string): Promise<AgentState> {
    return { ...this.agent, id: agentId } as AgentState;
  }

  async updateAgent(agentId: string): Promise<AgentState> {
    return { ...this.agent, id: agentId } as AgentState;
  }

  async retrieveConversation(conversationId: string): Promise<Conversation> {
    return {
      id: conversationId,
      agent_id: this.agent.id,
      in_context_message_ids: [],
    } as unknown as Conversation;
  }

  async createConversation(
    body: ConversationCreateBody,
  ): Promise<Conversation> {
    this.conversationId = "conv-fake-headless";
    return {
      id: this.conversationId,
      agent_id: body.agent_id ?? this.agent.id,
      in_context_message_ids: [],
    } as unknown as Conversation;
  }

  async updateConversation(conversationId: string): Promise<Conversation> {
    return this.retrieveConversation(conversationId);
  }

  listConversationMessages(): ReturnType<Backend["listConversationMessages"]> {
    return Promise.resolve(createEmptyPage() as never);
  }

  listAgentMessages(): ReturnType<Backend["listAgentMessages"]> {
    return Promise.resolve(createEmptyPage() as never);
  }

  retrieveMessage(): ReturnType<Backend["retrieveMessage"]> {
    return Promise.resolve([] as never);
  }

  async createConversationMessageStream(
    _conversationId: string,
    _body: ConversationMessageCreateBody,
  ) {
    return createFakeStream("pong");
  }

  async streamConversationMessages() {
    return createFakeStream("pong");
  }

  async cancelConversation() {
    return { status: "cancelled" } as never;
  }

  async retrieveRun(runId: string) {
    return { id: runId, status: "completed", metadata: {} } as never;
  }

  async streamRunMessages(_runId: string, _body: RunMessageStreamBody) {
    return createFakeStream("pong");
  }

  async forkConversation(conversationId: string) {
    return { id: conversationId } as never;
  }
}
