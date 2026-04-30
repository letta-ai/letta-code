import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  Backend,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageStreamBody,
  RunMessageStreamBody,
} from "../backend";
import { FakeHeadlessStore } from "./FakeHeadlessStore";

function createPage<T>(items: T[]) {
  return {
    getPaginatedItems: () => items,
  };
}

function createFakeStream(message: {
  id: string;
  date: string;
  content?: unknown;
}): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "assistant_message",
        id: message.id,
        date: message.date,
        content: message.content ?? [{ type: "text", text: "pong" }],
      } as LettaStreamingResponse;
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

export class FakeHeadlessBackend implements Backend {
  private readonly store: FakeHeadlessStore;

  constructor(agentId = "agent-fake-headless") {
    this.store = new FakeHeadlessStore(agentId);
  }

  async retrieveAgent(agentId: string): Promise<AgentState> {
    return this.store.ensureAgent(agentId);
  }

  updateAgent(...args: Parameters<Backend["updateAgent"]>) {
    const [agentId, body] = args;
    return Promise.resolve(this.store.updateAgent(agentId, body));
  }

  async retrieveConversation(conversationId: string): Promise<Conversation> {
    return this.store.retrieveConversation(conversationId);
  }

  async createConversation(
    body: ConversationCreateBody,
  ): Promise<Conversation> {
    return this.store.createConversation(body);
  }

  updateConversation(...args: Parameters<Backend["updateConversation"]>) {
    const [conversationId, body] = args;
    return Promise.resolve(this.store.updateConversation(conversationId, body));
  }

  listConversationMessages(
    ...args: Parameters<Backend["listConversationMessages"]>
  ): ReturnType<Backend["listConversationMessages"]> {
    const [conversationId, body] = args;
    return Promise.resolve(
      createPage(
        this.store.listConversationMessages(conversationId, body),
      ) as never,
    );
  }

  listAgentMessages(
    ...args: Parameters<Backend["listAgentMessages"]>
  ): ReturnType<Backend["listAgentMessages"]> {
    const [agentId, body] = args;
    return Promise.resolve(
      createPage(this.store.listAgentMessages(agentId, body)) as never,
    );
  }

  retrieveMessage(
    ...args: Parameters<Backend["retrieveMessage"]>
  ): ReturnType<Backend["retrieveMessage"]> {
    const [messageId] = args;
    return Promise.resolve(this.store.retrieveMessage(messageId) as never);
  }

  async createConversationMessageStream(
    conversationId: string,
    body: ConversationMessageCreateBody,
  ) {
    const assistantMessage = this.store.appendTurn(conversationId, body);
    return createFakeStream(assistantMessage);
  }

  async streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
  ) {
    const assistantMessage = this.store.appendTurn(conversationId, body);
    return createFakeStream(assistantMessage);
  }

  async cancelConversation() {
    return { status: "cancelled" } as never;
  }

  async retrieveRun(runId: string) {
    return { id: runId, status: "completed", metadata: {} } as never;
  }

  async streamRunMessages(_runId: string, _body: RunMessageStreamBody) {
    return createFakeStream({
      id: "msg-fake-headless-run",
      date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      content: [{ type: "text", text: "pong" }],
    });
  }

  async forkConversation(conversationId: string) {
    return { id: conversationId } as never;
  }
}
