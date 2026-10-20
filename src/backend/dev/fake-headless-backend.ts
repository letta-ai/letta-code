import { APIUserAbortError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  LettaStreamingResponse,
  Run,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { mapModelHandleToLlmConfigPatch } from "@/agent/model-handles";
import type {
  Backend,
  BackendCapabilities,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  ConversationResumeTail,
  ConversationResumeTailOptions,
  RunMessageStreamBody,
} from "@/backend/backend";
import { localConversationKey } from "@/backend/local/local-conversation-key";
import {
  LocalBackendNotFoundError,
  LocalStore,
  type LocalStoreOptions,
} from "@/backend/local/local-store";
import { isLocalStateChunkOnly } from "@/backend/local/local-stream-chunks";
import type { LocalAgentRecord } from "@/backend/local/local-types";
import { TURN_DID_NOT_COMPLETE } from "@/constants";
import { isRecord } from "@/utils/type-guards";
import {
  DeterministicPongExecutor,
  type HeadlessTurnExecutor,
} from "./headless-turn-executor";
import {
  type LocalProviderErrorInfo,
  normalizeLocalProviderError,
} from "./local-provider-errors";

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

type RunErrorMetadata = Pick<
  LocalProviderErrorInfo,
  "message" | "detail" | "error_type" | "retryable"
> & { run_id?: string };

function runErrorInfo(
  chunk: LettaStreamingResponse,
): RunErrorMetadata | undefined {
  if (chunk.message_type !== "error_message") return undefined;
  const record = chunk as {
    message?: unknown;
    detail?: unknown;
    error_type?: unknown;
    retryable?: unknown;
  };
  const message = typeof record.message === "string" ? record.message : "";
  const detail =
    typeof record.detail === "string"
      ? record.detail
      : message || "Unknown local backend error";
  const errorType =
    record.error_type === "llm_error" ||
    record.error_type === "local_backend_error"
      ? record.error_type
      : "local_backend_error";
  return {
    message: message || detail,
    detail,
    error_type: errorType,
    retryable: record.retryable === true,
  };
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

function localStreamProtocolError(message: string): RunErrorMetadata {
  return {
    message,
    detail: message,
    error_type: "local_backend_error",
    retryable: false,
  };
}

function localErrorChunk(info: RunErrorMetadata): LettaStreamingResponse {
  return {
    message_type: "error_message",
    message: info.message,
    detail: info.detail,
    error_type: info.error_type,
    retryable: info.retryable,
  } as unknown as LettaStreamingResponse;
}

function localStopReasonChunk(stopReason: string): LettaStreamingResponse {
  return {
    message_type: "stop_reason",
    stop_reason: stopReason,
  } as LettaStreamingResponse;
}

function effectiveAgentForConversation(
  agent: LocalAgentRecord,
  conversation: Conversation,
): LocalAgentRecord {
  const conversationRecord = conversation as unknown as Record<string, unknown>;
  const conversationModelSettings = isRecord(conversationRecord.model_settings)
    ? conversationRecord.model_settings
    : undefined;
  return {
    ...agent,
    ...(typeof conversationRecord.model === "string"
      ? { model: conversationRecord.model }
      : {}),
    model_settings: {
      ...agent.model_settings,
      ...(conversationModelSettings ?? {}),
      ...(typeof conversationRecord.context_window_limit === "number"
        ? { context_window_limit: conversationRecord.context_window_limit }
        : {}),
    },
  };
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

export const HEADLESS_BACKEND_CAPABILITIES: BackendCapabilities = {
  remoteMemfs: false,
  serverSideToolManagement: false,
  serverSecrets: false,
  promptRecompile: false,
  byokProviderRefresh: false,
  localModelCatalog: true,
  localMemfs: false,
  environmentRouting: false,
};

export class HeadlessBackend implements Backend {
  readonly capabilities = HEADLESS_BACKEND_CAPABILITIES;

  protected readonly store: LocalStore;
  private readonly executor: HeadlessTurnExecutor;
  private readonly runs = new Map<string, Run>();
  // Keyed by localConversationKey: "default" is per-agent, so a bare
  // conversation id would let two agents' default chats collide.
  private readonly activeRunByConversation = new Map<string, string>();
  private readonly runControllerByRunId = new Map<string, AbortController>();
  // Fires when a run is cancelled (or its turn signal aborts) while the turn
  // is still in async startup, so a hung startup promise cannot wedge the
  // send: the startup awaits race this preemption.
  private readonly runStartupPreemptByRunId = new Map<string, () => void>();
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
    return this.store.retrievePublicConversation(conversationId);
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

  async compactConversationMessages(
    ..._args: Parameters<Backend["compactConversationMessages"]>
  ): ReturnType<Backend["compactConversationMessages"]> {
    throw new Error("Compaction is not supported by this backend yet");
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

  async getConversationResumeTail(
    agentId: string,
    conversationId: string,
    options: ConversationResumeTailOptions,
  ): Promise<ConversationResumeTail> {
    const body = {
      limit: options.limit,
      order: "desc",
      include_return_message_types: options.includeReturnMessageTypes,
    } as ConversationMessageListBody;

    if (conversationId && conversationId !== "default") {
      const conversation = this.store.retrieveConversation(
        conversationId,
        agentId,
      );
      return {
        conversation,
        messages: this.store.listConversationMessages(conversation.id, {
          ...body,
          agent_id: agentId,
        } as ConversationMessageListBody) as never,
      };
    }

    return {
      messages: this.store.listAgentMessages(agentId, {
        ...body,
        conversation_id: "default",
      } as never) as never,
    };
  }

  async listModels(): ReturnType<Backend["listModels"]> {
    const llmConfigPatch = mapModelHandleToLlmConfigPatch(this.modelHandle);
    return [
      {
        handle: this.modelHandle,
        model: llmConfigPatch.model ?? this.modelHandle,
        model_endpoint_type: llmConfigPatch.model_endpoint_type ?? "openai",
      },
    ] as never;
  }

  async createConversationMessageStream(
    conversationId: string,
    body: ConversationMessageCreateBody,
    options?: { signal?: AbortSignal },
  ) {
    return this.executeConversationTurn(conversationId, body, options);
  }

  async streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
    options?: { signal?: AbortSignal },
  ) {
    return this.executeConversationTurn(conversationId, body, options);
  }

  async cancelConversation(...args: Parameters<Backend["cancelConversation"]>) {
    const [conversationIdOrAgentId] = args;
    // Callers pass the agent id for a default conversation, else the
    // conversation id; try both scoped keys before the agent-wide fallback.
    const runId =
      this.activeRunByConversation.get(
        localConversationKey(
          conversationIdOrAgentId,
          this.store.resolveAgentIdForConversation(conversationIdOrAgentId),
        ),
      ) ??
      this.activeRunByConversation.get(
        localConversationKey("default", conversationIdOrAgentId),
      ) ??
      this.findActiveRunByAgentId(conversationIdOrAgentId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (run?.conversation_id && run.agent_id) {
      this.store.settleInterruptedToolCalls(run.conversation_id, {
        agentId: run.agent_id,
      });
    } else {
      this.store.settleInterruptedToolCalls(conversationIdOrAgentId);
    }
    if (runId) {
      const controller = this.runControllerByRunId.get(runId);
      // Captured before completeRun clears it: preemption must still reach a
      // turn parked in hung startup.
      const preemptStartup = this.runStartupPreemptByRunId.get(runId);
      this.recordRunChunk(runId, {
        message_type: "stop_reason",
        stop_reason: "cancelled",
      } as LettaStreamingResponse);
      this.completeRun(runId, "cancelled");
      controller?.abort();
      preemptStartup?.();
    }
    return { status: "cancelled" } as never;
  }

  async cancelRun(...args: Parameters<Backend["cancelRun"]>) {
    const [agentId, runId] = args;
    const run = this.runs.get(runId);
    if (!run || run.agent_id !== agentId || isTerminalRun(run)) {
      return { [runId]: "failed" } as never;
    }

    return this.cancelRunById(runId);
  }

  private async cancelRunById(runId: string) {
    const run = this.runs.get(runId);
    if (!run || isTerminalRun(run)) {
      return { [runId]: "failed" } as never;
    }

    if (run.conversation_id) {
      this.store.settleInterruptedToolCalls(run.conversation_id, {
        agentId: run.agent_id,
      });
    } else {
      this.store.settleInterruptedToolCalls(run.agent_id);
    }
    const controller = this.runControllerByRunId.get(runId);
    // Captured before completeRun clears it, as in cancelConversation.
    const preemptStartup = this.runStartupPreemptByRunId.get(runId);
    this.recordRunChunk(runId, {
      message_type: "stop_reason",
      stop_reason: "cancelled",
    } as LettaStreamingResponse);
    this.completeRun(runId, "cancelled");
    controller?.abort();
    preemptStartup?.();
    return { [runId]: "cancelled" } as never;
  }

  async cancelConversationRun(
    ...args: Parameters<Backend["cancelConversationRun"]>
  ) {
    const [conversationId, requestedRunId] = args;
    const runId =
      requestedRunId ??
      this.activeRunByConversation.get(
        localConversationKey(
          conversationId,
          this.store.resolveAgentIdForConversation(conversationId),
        ),
      );
    if (!runId) return {} as never;
    const run = this.runs.get(runId);
    if (!run || run.conversation_id !== conversationId || isTerminalRun(run)) {
      return { [runId]: "failed" } as never;
    }
    return this.cancelRunById(runId);
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
    options?: { signal?: AbortSignal },
  ) {
    // Honor a pre-aborted turn signal before persisting input or starting a
    // run: a cancel that landed during pre-stream prep found no run to stop,
    // so this send must not leave an orphaned active run behind.
    if (options?.signal?.aborted) {
      throw new APIUserAbortError();
    }
    const turnAgentId =
      (body as { agent_id?: string }).agent_id ??
      this.store.resolveAgentIdForConversation(conversationId);
    const activeRunId = this.activeRunByConversation.get(
      localConversationKey(conversationId, turnAgentId),
    );
    const activeRun = activeRunId ? this.runs.get(activeRunId) : undefined;
    if (activeRun && !isTerminalRun(activeRun)) {
      throw new Error(
        `Conversation ${conversationId} already has an active run (${activeRun.id})`,
      );
    }
    // Settle any tool calls left without results from a prior interrupted turn.
    // If the process was killed or the stream errored out before cancelConversation
    // was called, orphaned tool_use blocks remain in the history. Anthropic rejects
    // any subsequent turn that includes them, so we add synthetic error results here
    // before assembling the context for the new turn.
    //
    // Skip when the incoming turn is an approval — that means the previous turn
    // ended with requires_approval and the tool call is intentionally pending,
    // waiting for the user's approval response in this very turn.
    const messages = (body as { messages?: unknown[] }).messages ?? [];
    const isApprovalTurn = messages.some(
      (m) => (m as { type?: string }).type === "approval",
    );
    if (!isApprovalTurn) {
      this.store.settleInterruptedToolCalls(conversationId, {
        reason: TURN_DID_NOT_COMPLETE,
      });
    }

    const turnInput = this.store.appendTurnInput(conversationId, body);
    const run = this.startRun(
      turnInput.conversationId,
      turnInput.agentId,
      body,
    );
    // Startup preemption: until a stream controller is registered, the cancel
    // paths cannot abort provider work — and a hung prompt/provider startup
    // would wedge the send forever. The cancel paths and the turn signal fire
    // this deferred; the startup awaits below race it so a cancel unwinds the
    // send promptly even when the startup promise never settles.
    let preemptStartup!: () => void;
    const startupPreempted = new Promise<never>((_, reject) => {
      preemptStartup = () => reject(new APIUserAbortError());
    });
    // The preemption promise intentionally rejects and is only raced, so an
    // abort after startup finished must never surface as unhandled.
    startupPreempted.catch(() => {});
    this.runStartupPreemptByRunId.set(run.id, preemptStartup);
    const preemptOnSignal = () => preemptStartup();
    options?.signal?.addEventListener("abort", preemptOnSignal, {
      once: true,
    });
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
    const agent = effectiveAgentForConversation(
      this.store.retrieveExecutionAgentRecord(
        turnInput.conversationId,
        turnInput.agentId,
      ),
      this.store.retrieveConversation(
        turnInput.conversationId,
        turnInput.agentId,
      ),
    );
    let resolvedPrompt:
      | string
      | {
          systemPrompt: string;
          midConversationSystemPrompt?: string;
        };
    try {
      // Deferred through Promise.resolve().then: a synchronously throwing
      // override becomes a rejection the inner catch can failRun on instead
      // of leaking an active run past the finally.
      const promptPromise = Promise.resolve().then(() =>
        this.resolveSystemPromptForTurn({
          conversationId: turnInput.conversationId,
          agentId: turnInput.agentId,
          agent,
          body,
          history,
          uiMessages,
        }),
      );
      try {
        resolvedPrompt = await Promise.race([promptPromise, startupPreempted]);
      } catch (error) {
        // Swallow a late prompt rejection so it never surfaces unhandled.
        promptPromise.catch(() => {});
        // Cancellation dominates a prep rejection: after Esc this is a user
        // interrupt, never a stream error — and the run must not stay active
        // even if the backend cancel failed to land.
        if (this.turnWasAborted(run.id, options?.signal)) {
          this.cancelUnobservedRun(run.id);
          throw new APIUserAbortError();
        }
        this.failRun(run.id, error);
        throw error;
      }
      const systemPrompt =
        typeof resolvedPrompt === "string"
          ? resolvedPrompt
          : resolvedPrompt.systemPrompt;
      const midConversationSystemPrompt =
        typeof resolvedPrompt === "string"
          ? undefined
          : resolvedPrompt.midConversationSystemPrompt;
      // A cancel that landed during prompt prep found no registered
      // controller to abort; re-check before starting provider execution so
      // an already-cancelled run never begins orphaned provider work.
      if (this.turnWasAborted(run.id, options?.signal)) {
        this.cancelUnobservedRun(run.id);
        throw new APIUserAbortError();
      }
      let stream: Stream<LettaStreamingResponse>;
      // Same sync-throw containment for injected executors.
      const executePromise = Promise.resolve().then(() =>
        this.executor.execute({
          conversationId: turnInput.conversationId,
          agentId: turnInput.agentId,
          agent,
          systemPrompt,
          midConversationSystemPrompt,
          body,
          history,
          uiMessages,
        }),
      );
      try {
        stream = await Promise.race([executePromise, startupPreempted]);
      } catch (error) {
        // Cancellation dominates a provider/startup rejection after Esc.
        if (this.turnWasAborted(run.id, options?.signal)) {
          // Abort the controller a hung startup may still hand back, and
          // swallow a late startup rejection.
          void executePromise.then(
            (late) => late.controller.abort(),
            () => {},
          );
          this.cancelUnobservedRun(run.id);
          throw new APIUserAbortError();
        }
        this.failRun(run.id, error);
        throw error;
      }
      // The same race one await later: abort the fresh controller
      // immediately instead of registering it for an already-cancelled run,
      // and unwind as a user interrupt rather than returning a stream nobody
      // will consume.
      if (this.turnWasAborted(run.id, options?.signal)) {
        stream.controller.abort();
        this.cancelUnobservedRun(run.id);
        throw new APIUserAbortError();
      }
      this.runControllerByRunId.set(run.id, stream.controller);
      return this.persistExecutorStream(
        turnInput.conversationId,
        turnInput.agentId,
        stream,
        run.id,
      );
    } finally {
      this.runStartupPreemptByRunId.delete(run.id);
      options?.signal?.removeEventListener("abort", preemptOnSignal);
    }
  }

  protected async resolveSystemPromptForTurn(input: {
    conversationId: string;
    agentId: string;
    agent: ReturnType<LocalStore["retrieveAgentRecord"]>;
    body: ConversationMessageCreateBody | ConversationMessageStreamBody;
    history: ReturnType<LocalStore["listConversationMessages"]>;
    uiMessages: ReturnType<LocalStore["listLocalMessages"]>;
  }): Promise<
    string | { systemPrompt: string; midConversationSystemPrompt?: string }
  > {
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
    this.activeRunByConversation.set(
      localConversationKey(conversationId, agentId),
      run.id,
    );
    return run;
  }

  private completeRun(
    runId: string,
    stopReason: string,
    errorInfo?: RunErrorMetadata,
  ): void {
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
      metadata:
        status === "failed" && errorInfo
          ? {
              ...(run.metadata ?? {}),
              error: {
                ...errorInfo,
                run_id: runId,
              },
            }
          : run.metadata,
    });
    this.releaseActiveRun(run);
    this.runControllerByRunId.delete(runId);
    this.runStartupPreemptByRunId.delete(runId);
  }

  private failRun(runId: string, error: unknown): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (isTerminalRun(run)) return;
    const info = normalizeLocalProviderError(error);
    this.runs.set(runId, {
      ...run,
      status: "failed",
      stop_reason: info.stop_reason as Run["stop_reason"],
      completed_at: timestampForRun(this.runSeq + this.runs.size),
      metadata: {
        ...(run.metadata ?? {}),
        error: {
          message: info.message,
          detail: info.detail,
          error_type: info.error_type,
          retryable: info.retryable,
          run_id: runId,
        },
      },
    });
    this.releaseActiveRun(run);
    this.runControllerByRunId.delete(runId);
    this.runStartupPreemptByRunId.delete(runId);
  }

  // Cancel a run whose turn was aborted while no stream controller was
  // registered (mid prompt/provider prep): cancelConversation's controller
  // abort is a no-op in that window, so close the run here instead. No-op
  // when cancelConversation already recorded and completed the run.
  private cancelUnobservedRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || isTerminalRun(run)) return;
    this.recordRunChunk(runId, {
      message_type: "stop_reason",
      stop_reason: "cancelled",
    } as LettaStreamingResponse);
    this.completeRun(runId, "cancelled");
  }

  // A turn is aborted once the caller's signal fired OR the run is already
  // terminal: cancelConversation/cancelRun/cancelConversationRun can cancel
  // backend-only during prep without aborting the request signal, and any
  // further work from either path belongs to a cancelled run.
  private turnWasAborted(runId: string, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    const run = this.runs.get(runId);
    return run ? isTerminalRun(run) : false;
  }

  // Only drop the entry this run owns: a stale run's cleanup must not clear
  // a newer run's ownership of the same conversation.
  private releaseActiveRun(run: Run): void {
    if (!run.conversation_id) return;
    const key = localConversationKey(run.conversation_id, run.agent_id);
    if (this.activeRunByConversation.get(key) === run.id) {
      this.activeRunByConversation.delete(key);
    }
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
        let sawApprovalRequest = false;
        let pendingErrorInfo: RunErrorMetadata | undefined;
        try {
          for await (const rawChunk of stream) {
            const chunk = attachRunId(rawChunk, runId);
            if (chunk.message_type === "approval_request_message") {
              sawApprovalRequest = true;
            }
            const errorInfo = runErrorInfo(chunk);
            if (errorInfo) {
              pendingErrorInfo = errorInfo;
            }
            const stopReason = runStopReason(chunk);
            if (stopReason) {
              sawStopReason = true;
              backend.completeRun(runId, stopReason, pendingErrorInfo);
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
            if (pendingErrorInfo) {
              backend.completeRun(runId, "error", pendingErrorInfo);
              yield backend.recordRunChunk(
                runId,
                attachRunId(localStopReasonChunk("error"), runId),
              );
            } else if (sawApprovalRequest) {
              backend.completeRun(runId, "requires_approval");
              yield backend.recordRunChunk(
                runId,
                attachRunId(localStopReasonChunk("requires_approval"), runId),
              );
            } else {
              const info = localStreamProtocolError(
                "Local provider stream ended without a stop reason.",
              );
              backend.completeRun(runId, "error", info);
              for (const terminalChunk of [
                localErrorChunk(info),
                localStopReasonChunk("error"),
              ]) {
                const chunk = attachRunId(terminalChunk, runId);
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
            }
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
