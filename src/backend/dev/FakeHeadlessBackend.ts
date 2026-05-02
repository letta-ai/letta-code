import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  LettaStreamingResponse,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  Backend,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  RunMessageStreamBody,
} from "../backend";
import {
  FakeHeadlessStore,
  type FakeHeadlessStoreOptions,
} from "./FakeHeadlessStore";
import {
  createAssistantMessageStream,
  DeterministicPongExecutor,
  type HeadlessTurnExecutor,
} from "./HeadlessTurnExecutor";
import { isProviderStreamPartOnly } from "./ProviderTrajectory";

function createPage<T>(items: T[]) {
  return {
    getPaginatedItems: () => items,
  };
}

function timestampForRun(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
}

function runStopReason(chunk: LettaStreamingResponse): string | undefined {
  if (chunk.message_type !== "stop_reason") return undefined;
  const stopReason = (chunk as { stop_reason?: unknown }).stop_reason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

function runErrorMessage(chunk: LettaStreamingResponse): string | undefined {
  if (chunk.message_type !== "error_message") return undefined;
  const message = (chunk as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function attachRunId(
  chunk: LettaStreamingResponse,
  runId: string,
): LettaStreamingResponse {
  (chunk as { run_id?: string }).run_id = runId;
  return chunk;
}

export class FakeHeadlessBackend implements Backend {
  readonly capabilities = { remoteMemfs: false };

  private readonly store: FakeHeadlessStore;
  private readonly executor: HeadlessTurnExecutor;
  private readonly runs = new Map<string, Run>();
  private readonly activeRunByConversation = new Map<string, string>();
  private runSeq = 0;

  constructor(
    agentId = "agent-fake-headless",
    executor: HeadlessTurnExecutor = new DeterministicPongExecutor(),
    storeOptions: FakeHeadlessStoreOptions = {},
  ) {
    this.store = new FakeHeadlessStore(agentId, storeOptions);
    this.executor = executor;
  }

  async retrieveAgent(agentId: string): Promise<AgentState> {
    return this.store.retrieveAgent(agentId);
  }

  async updateAgent(...args: Parameters<Backend["updateAgent"]>) {
    const [agentId, body] = args;
    return this.store.updateAgent(agentId, body);
  }

  createAgent(...args: Parameters<Backend["createAgent"]>) {
    const [body] = args;
    return Promise.resolve(this.store.createAgent(body));
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

  async listConversationMessages(
    ...args: Parameters<Backend["listConversationMessages"]>
  ): ReturnType<Backend["listConversationMessages"]> {
    const [conversationId, body] = args;
    return createPage(
      this.store.listConversationMessages(conversationId, body),
    ) as never;
  }

  async listAgentMessages(
    ...args: Parameters<Backend["listAgentMessages"]>
  ): ReturnType<Backend["listAgentMessages"]> {
    const [agentId, body] = args;
    return createPage(this.store.listAgentMessages(agentId, body)) as never;
  }

  async retrieveMessage(
    ...args: Parameters<Backend["retrieveMessage"]>
  ): ReturnType<Backend["retrieveMessage"]> {
    const [messageId] = args;
    return this.store.retrieveMessage(messageId) as never;
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
    return this.executeConversationTurn(conversationId, body);
  }

  async streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
  ) {
    return this.executeConversationTurn(conversationId, body);
  }

  async cancelConversation() {
    return { status: "cancelled" } as never;
  }

  async retrieveRun(runId: string) {
    return (this.runs.get(runId) ?? {
      id: runId,
      status: "completed",
      metadata: {},
    }) as never;
  }

  async streamRunMessages(_runId: string, _body: RunMessageStreamBody) {
    return createAssistantMessageStream({
      id: "msg-fake-headless-run",
      date: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      content: [{ type: "text", text: "pong" }],
    });
  }

  async forkConversation(...args: Parameters<Backend["forkConversation"]>) {
    const [conversationId, options] = args;
    return this.store.forkConversation(conversationId, options);
  }

  private async executeConversationTurn(
    conversationId: string,
    body: ConversationMessageCreateBody | ConversationMessageStreamBody,
  ) {
    const turnInput = this.store.appendTurnInput(conversationId, body);
    const run = this.startRun(
      turnInput.conversationId,
      turnInput.agentId,
      body,
    );
    const history = this.store.listConversationMessages(
      turnInput.conversationId,
      {
        agent_id: turnInput.agentId,
        order: "asc",
      } as ConversationMessageListBody,
    );
    const providerTrajectory = this.store.listProviderTrajectory(
      turnInput.conversationId,
      turnInput.agentId,
    );
    const agent = this.store.retrieveAgentRecord(turnInput.agentId);
    let stream: Stream<LettaStreamingResponse>;
    try {
      stream = await this.executor.execute({
        conversationId: turnInput.conversationId,
        agentId: turnInput.agentId,
        agent,
        body,
        history,
        providerTrajectory,
      });
    } catch (error) {
      this.failRun(run.id, error);
      throw error;
    }
    return this.persistExecutorStream(
      turnInput.conversationId,
      turnInput.agentId,
      stream,
      run.id,
    );
  }

  private startRun(
    conversationId: string,
    agentId: string,
    body: ConversationMessageCreateBody | ConversationMessageStreamBody,
  ): Run {
    this.runSeq += 1;
    const createdAt = timestampForRun(this.runSeq);
    const run = {
      id: `run-fake-headless-${this.runSeq}`,
      agent_id: agentId,
      conversation_id: conversationId,
      status: "running",
      created_at: createdAt,
      background:
        typeof (body as { background?: unknown }).background === "boolean"
          ? (body as { background: boolean }).background
          : null,
      metadata: {
        backend: "fake-headless",
      },
    } as Run;
    this.runs.set(run.id, run);
    this.activeRunByConversation.set(conversationId, run.id);
    return run;
  }

  private completeRun(runId: string, stopReason: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const completedAt = timestampForRun(this.runSeq + this.runs.size);
    const status =
      stopReason === "error" || stopReason === "llm_api_error"
        ? "failed"
        : stopReason === "cancelled"
          ? "cancelled"
          : "completed";
    this.runs.set(runId, {
      ...run,
      status,
      stop_reason: stopReason as Run["stop_reason"],
      completed_at: completedAt,
    });
    if (run.conversation_id) {
      this.activeRunByConversation.delete(run.conversation_id);
    }
  }

  private failRun(runId: string, error: unknown): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const message = error instanceof Error ? error.message : String(error);
    this.runs.set(runId, {
      ...run,
      status: "failed",
      stop_reason: "error",
      completed_at: timestampForRun(this.runSeq + this.runs.size),
      metadata: {
        ...(run.metadata ?? {}),
        error: {
          message,
          error_type: "local_backend_error",
          run_id: runId,
        },
      },
    });
  }

  private persistExecutorStream(
    conversationId: string,
    agentId: string,
    stream: Stream<LettaStreamingResponse>,
    runId: string,
  ): Stream<LettaStreamingResponse> {
    const store = this.store;
    const backend = this;
    return {
      controller: stream.controller,
      async *[Symbol.asyncIterator]() {
        let sawStopReason = false;
        try {
          for await (const rawChunk of stream) {
            const chunk = attachRunId(rawChunk, runId);
            const errorMessage = runErrorMessage(chunk);
            if (errorMessage) {
              backend.failRun(runId, new Error(errorMessage));
            }
            const stopReason = runStopReason(chunk);
            if (stopReason) {
              sawStopReason = true;
              backend.completeRun(runId, stopReason);
            }

            const persisted = store.appendStreamChunk(
              conversationId,
              agentId,
              chunk,
            );
            if (!isProviderStreamPartOnly(persisted)) {
              yield attachRunId(persisted, runId);
            }
          }
          if (!sawStopReason) {
            backend.completeRun(runId, "end_turn");
          }
        } catch (error) {
          backend.failRun(runId, error);
          throw error;
        }
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }
}
