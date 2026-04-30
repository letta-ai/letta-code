import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  Backend,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageStreamBody,
  RunMessageStreamBody,
} from "../backend";
import { FakeHeadlessStore } from "./FakeHeadlessStore";
import {
  createAssistantMessageStream,
  DeterministicPongExecutor,
  type HeadlessTurnExecutor,
} from "./HeadlessTurnExecutor";

function createPage<T>(items: T[]) {
  return {
    getPaginatedItems: () => items,
  };
}

export class FakeHeadlessBackend implements Backend {
  private readonly store: FakeHeadlessStore;
  private readonly executor: HeadlessTurnExecutor;

  constructor(
    agentId = "agent-fake-headless",
    executor: HeadlessTurnExecutor = new DeterministicPongExecutor(),
  ) {
    this.store = new FakeHeadlessStore(agentId);
    this.executor = executor;
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
    return this.executor.execute({ conversationId, body, store: this.store });
  }

  async streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
  ) {
    return this.executor.execute({ conversationId, body, store: this.store });
  }

  async cancelConversation() {
    return { status: "cancelled" } as never;
  }

  async retrieveRun(runId: string) {
    return { id: runId, status: "completed", metadata: {} } as never;
  }

  async streamRunMessages(_runId: string, _body: RunMessageStreamBody) {
    return createAssistantMessageStream({
      id: "msg-fake-headless-run",
      date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      content: [{ type: "text", text: "pong" }],
    });
  }

  async forkConversation(conversationId: string) {
    return { id: conversationId } as never;
  }
}
