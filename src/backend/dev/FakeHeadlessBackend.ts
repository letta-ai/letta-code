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
  readonly capabilities = {
    remoteMemfs: false,
    serverSideToolManagement: false,
    serverSecrets: false,
    agentFileImportExport: false,
    promptRecompile: false,
    byokProviderRefresh: false,
    localModelCatalog: true,
  };

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

  async listAgents(...args: Parameters<Backend["listAgents"]>) {
    const [body] = args;
    return this.store.listAgents(body) as never;
  }

  async deleteAgent(...args: Parameters<Backend["deleteAgent"]>) {
    const [agentId] = args;
    this.store.deleteAgent(agentId);
    return undefined as never;
  }

  updateAgent(...args: Parameters<Backend["updateAgent"]>) {
    const [agentId, body] = args;
    return Promise.resolve(this.store.updateAgent(agentId, body));
  }

  createAgent(...args: Parameters<Backend["createAgent"]>) {
    const [body] = args;
    return Promise.resolve(this.store.createAgent(body));
  }

  async retrieveConversation(conversationId: string): Promise<Conversation> {
    return this.store.retrieveConversation(conversationId);
  }

  async listConversations(...args: Parameters<Backend["listConversations"]>) {
    const [body] = args;
    return this.store.listConversations(body) as never;
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

  async listModels(): ReturnType<Backend["listModels"]> {
    return [
      {
        handle: "dev/fake-headless",
        model: "dev/fake-headless",
        model_endpoint_type: "openai",
      },
    ] as never;
  }

  async createConversationMessageStream(
    conversationId: string,
    body: ConversationMessageCreateBody,
  ) {
    const turnInput = this.store.appendTurnInput(conversationId, body);
    const stream = await this.executor.execute({
      conversationId,
      agentId: turnInput.agentId,
      body,
    });
    return this.persistExecutorStream(
      turnInput.conversationId,
      turnInput.agentId,
      stream,
    );
  }

  async streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
  ) {
    const turnInput = this.store.appendTurnInput(conversationId, body);
    const stream = await this.executor.execute({
      conversationId,
      agentId: turnInput.agentId,
      body,
    });
    return this.persistExecutorStream(
      turnInput.conversationId,
      turnInput.agentId,
      stream,
    );
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

  private persistExecutorStream(
    conversationId: string,
    agentId: string,
    stream: Stream<LettaStreamingResponse>,
  ): Stream<LettaStreamingResponse> {
    const store = this.store;
    return {
      controller: stream.controller,
      async *[Symbol.asyncIterator]() {
        for await (const chunk of stream) {
          yield store.appendStreamChunk(conversationId, agentId, chunk);
        }
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }
}
