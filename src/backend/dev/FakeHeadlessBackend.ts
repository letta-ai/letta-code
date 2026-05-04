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
  LocalBackendNotFoundError,
  LocalStore,
  type LocalStoreOptions,
} from "../local/LocalStore";
import { isLocalStateChunkOnly } from "../local/LocalStreamChunks";
import {
  DeterministicPongExecutor,
  type HeadlessTurnExecutor,
} from "./HeadlessTurnExecutor";

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

function chunkSeqId(chunk: LettaStreamingResponse): number | undefined {
  const seqId = (chunk as { seq_id?: unknown }).seq_id;
  return typeof seqId === "number" ? seqId : undefined;
}

function cloneStreamingChunk(
  chunk: LettaStreamingResponse,
): LettaStreamingResponse {
  return JSON.parse(JSON.stringify(chunk)) as LettaStreamingResponse;
}

function createReplayStream(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield cloneStreamingChunk(chunk);
      }
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function isTerminalRun(run: Run): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

export interface HeadlessBackendOptions {
  modelHandle?: string;
  runIdPrefix?: string;
  runMetadataBackend?: string;
}

const FAKE_HEADLESS_MODEL = "dev/fake-headless";

export class HeadlessBackend implements Backend {
  readonly capabilities = {
    remoteMemfs: false,
    serverSideToolManagement: false,
    serverSecrets: false,
    agentFileImportExport: false,
    promptRecompile: false,
    byokProviderRefresh: false,
    localModelCatalog: true,
    localMemfs: false,
  };

  protected readonly store: LocalStore;
  private readonly executor: HeadlessTurnExecutor;
  private readonly runs = new Map<string, Run>();
  private readonly activeRunByConversation = new Map<string, string>();
  private readonly runControllerByRunId = new Map<string, AbortController>();
  private readonly runChunksByRunId = new Map<
    string,
    LettaStreamingResponse[]
  >();
  private readonly modelHandle: string;
  private readonly runIdPrefix: string;
  private readonly runMetadataBackend: string;
  private runSeq = 0;

  constructor(
    agentId = "agent-fake-headless",
    executor: HeadlessTurnExecutor = new DeterministicPongExecutor(),
    storeOptions: LocalStoreOptions = {},
    options: HeadlessBackendOptions = {},
  ) {
    this.modelHandle = options.modelHandle ?? FAKE_HEADLESS_MODEL;
    this.runIdPrefix = options.runIdPrefix ?? "run-fake-headless-";
    this.runMetadataBackend = options.runMetadataBackend ?? "fake-headless";
    this.store = new LocalStore(agentId, {
      defaultAgentName: "Fake Headless Agent",
      defaultAgentModel: this.modelHandle,
      conversationIdPrefix: "conv-fake-headless-",
      storedMessageIdPrefix: "msg-fake-headless-",
      localMessageIdPrefix: "provider-msg-fake-headless-",
      ...storeOptions,
    });
    this.executor = executor;
  }

  async retrieveAgent(agentId: string): Promise<AgentState> {
    return this.store.retrieveAgent(agentId);
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

  async recompileConversation(
    ..._args: Parameters<Backend["recompileConversation"]>
  ): ReturnType<Backend["recompileConversation"]> {
    throw new Error("Prompt recompile is not supported by this backend yet");
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
        handle: this.modelHandle,
        model: this.modelHandle,
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

  async cancelConversation(...args: Parameters<Backend["cancelConversation"]>) {
    const [conversationIdOrAgentId] = args;
    const runId =
      this.activeRunByConversation.get(conversationIdOrAgentId) ??
      this.findActiveRunByAgentId(conversationIdOrAgentId);
    if (runId) {
      const controller = this.runControllerByRunId.get(runId);
      this.recordRunChunk(runId, {
        message_type: "stop_reason",
        stop_reason: "cancelled",
      } as LettaStreamingResponse);
      this.completeRun(runId, "cancelled");
      controller?.abort();
    }
    return { status: "cancelled" } as never;
  }

  async retrieveRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new LocalBackendNotFoundError("Run", runId);
    return run as never;
  }

  async streamRunMessages(runId: string, body: RunMessageStreamBody) {
    if (!this.runs.has(runId)) {
      throw new LocalBackendNotFoundError("Run", runId);
    }
    const startingAfter =
      typeof body?.starting_after === "number"
        ? body.starting_after
        : undefined;
    const chunks = (this.runChunksByRunId.get(runId) ?? []).filter((chunk) => {
      if (startingAfter === undefined) return true;
      return (chunkSeqId(chunk) ?? 0) > startingAfter;
    });
    return createReplayStream(chunks) as never;
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
    const uiMessages = this.store.listLocalMessages(
      turnInput.conversationId,
      turnInput.agentId,
    );
    const agent = this.store.retrieveAgentRecord(turnInput.agentId);
    const systemPrompt = await this.resolveSystemPromptForTurn({
      conversationId: turnInput.conversationId,
      agentId: turnInput.agentId,
      agent,
      body,
      history,
      uiMessages,
    });
    let stream: Stream<LettaStreamingResponse>;
    try {
      stream = await this.executor.execute({
        conversationId: turnInput.conversationId,
        agentId: turnInput.agentId,
        agent,
        systemPrompt,
        body,
        history,
        uiMessages,
      });
    } catch (error) {
      this.failRun(run.id, error);
      throw error;
    }
    this.runControllerByRunId.set(run.id, stream.controller);
    return this.persistExecutorStream(
      turnInput.conversationId,
      turnInput.agentId,
      stream,
      run.id,
    );
  }

  protected async resolveSystemPromptForTurn(input: {
    conversationId: string;
    agentId: string;
    agent: ReturnType<LocalStore["retrieveAgentRecord"]>;
    body: ConversationMessageCreateBody | ConversationMessageStreamBody;
    history: ReturnType<LocalStore["listConversationMessages"]>;
    uiMessages: ReturnType<LocalStore["listLocalMessages"]>;
  }): Promise<string> {
    return input.agent.system;
  }

  private startRun(
    conversationId: string,
    agentId: string,
    body: ConversationMessageCreateBody | ConversationMessageStreamBody,
  ): Run {
    this.runSeq += 1;
    const createdAt = timestampForRun(this.runSeq);
    const run = {
      id: `${this.runIdPrefix}${this.runSeq}`,
      agent_id: agentId,
      conversation_id: conversationId,
      status: "running",
      created_at: createdAt,
      background:
        typeof (body as { background?: unknown }).background === "boolean"
          ? (body as { background: boolean }).background
          : null,
      metadata: {
        backend: this.runMetadataBackend,
      },
    } as Run;
    this.runs.set(run.id, run);
    this.activeRunByConversation.set(conversationId, run.id);
    return run;
  }

  private completeRun(runId: string, stopReason: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (isTerminalRun(run)) return;
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
    this.runControllerByRunId.delete(runId);
  }

  private failRun(runId: string, error: unknown): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (isTerminalRun(run)) return;
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
    if (run.conversation_id) {
      this.activeRunByConversation.delete(run.conversation_id);
    }
    this.runControllerByRunId.delete(runId);
  }

  private findActiveRunByAgentId(agentId: string): string | undefined {
    for (const [runId, run] of this.runs.entries()) {
      if (run.agent_id === agentId && !isTerminalRun(run)) return runId;
    }
    return undefined;
  }

  private recordRunChunk(
    runId: string,
    chunk: LettaStreamingResponse,
  ): LettaStreamingResponse {
    const chunks = this.runChunksByRunId.get(runId) ?? [];
    const recorded = attachRunId(cloneStreamingChunk(chunk), runId);
    if (chunkSeqId(recorded) === undefined) {
      (recorded as { seq_id?: number }).seq_id = chunks.length + 1;
    }
    chunks.push(recorded);
    this.runChunksByRunId.set(runId, chunks);
    return recorded;
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
            if (!isLocalStateChunkOnly(persisted)) {
              yield backend.recordRunChunk(
                runId,
                attachRunId(persisted, runId),
              );
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

export { HeadlessBackend as FakeHeadlessBackend };
