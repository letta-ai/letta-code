import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { getInteractiveApprovalKind } from "@/tools/interactive-policy";
import type {
  ApprovalResponseBody,
  ControlRequest,
  ExternalToolCallRequestMessage,
  ExternalToolCallResult,
  ExternalToolDefinitionPayload,
  InputAcceptedResponseMessage,
  InputCommand,
  QueueUpdateMessage,
  RuntimeExternalToolsUpdateGroup,
  RuntimeExternalToolsUpdateResponseMessage,
  RuntimeScope,
  RuntimeStartCommand,
  RuntimeStartResponseMessage,
  StopReasonType,
  StreamDeltaMessage,
  WsProtocolMessage,
} from "@/types/app-server-protocol";
import {
  createMessageChannelIdempotencyScope,
  type MessageChannelIdempotencyScope,
} from "./message-channel-idempotency";
import { createChannelTurnProgressBuilder } from "./progress-builder";
import type {
  ChannelControlRequestEvent,
  ChannelDefaultPermissionMode,
  ChannelTurnLifecycleEvent,
  ChannelTurnProgressEvent,
  ChannelTurnSource,
} from "./types";

const MAX_ACCEPTED_CLIENT_MESSAGE_IDS = 2048;

export interface ChannelGatewayClient {
  close(): void;
  onMessage(listener: (message: WsProtocolMessage) => void): () => void;
  onExternalToolCall(
    handler: (
      request: ExternalToolCallRequestMessage,
    ) => Promise<ExternalToolCallResult> | ExternalToolCallResult,
  ): () => void;
  submitInput(
    command: Omit<InputCommand, "type">,
  ): Promise<InputAcceptedResponseMessage>;
  runtimeStart(
    options: Omit<RuntimeStartCommand, "type" | "request_id"> & {
      request_id?: string;
    },
  ): Promise<RuntimeStartResponseMessage>;
  runtimeExternalToolsUpdate(options: {
    updates: readonly RuntimeExternalToolsUpdateGroup[];
  }): Promise<RuntimeExternalToolsUpdateResponseMessage>;
}

export interface ChannelGatewayDelivery {
  runtime: RuntimeScope;
  content: MessageCreate["content"];
  sources: ChannelTurnSource[];
  clientMessageId: string;
  defaultPermissionMode?: ChannelDefaultPermissionMode;
}

export type ChannelGatewayHandoffDelivery = Omit<
  ChannelGatewayDelivery,
  "content"
>;

export interface ChannelGatewayHooks {
  buildExternalTool(
    runtime: RuntimeScope,
    sources: ChannelTurnSource[],
  ): Promise<ExternalToolDefinitionPayload | null>;
  executeExternalTool(
    request: ExternalToolCallRequestMessage,
    sources: ChannelTurnSource[],
    idempotencyScope?: MessageChannelIdempotencyScope | null,
  ): Promise<ExternalToolCallResult> | ExternalToolCallResult;
  onLifecycle(event: ChannelTurnLifecycleEvent): void | Promise<void>;
  onProgress(event: ChannelTurnProgressEvent): void | Promise<void>;
  onControlRequest(event: ChannelControlRequestEvent): void | Promise<void>;
  createRichDraft?(options: {
    batchId: string;
    sources: ChannelTurnSource[];
  }): ChannelGatewayRichDraft | null;
}

export interface ChannelGatewayRichDraft {
  handleDelta(delta: StreamDeltaMessage["delta"]): void;
  flushPending(): Promise<void>;
  dispose(): void;
}

export interface ChannelGatewayModelStatus {
  modelHandle: string | null;
  scope: "agent" | "conversation";
}

type ActiveGatewayTurn = {
  batchId: string;
  routingSources: ChannelTurnSource[];
  lifecycleSources: ChannelTurnSource[];
  progress: ReturnType<typeof createChannelTurnProgressBuilder>;
  richDraft: ChannelGatewayRichDraft | null;
  runId?: string;
  idempotencyScope: MessageChannelIdempotencyScope;
};

type GatewayRuntimeState = {
  runtime: RuntimeScope;
  pendingSourcesByClientMessageId: Map<
    string,
    {
      sources: ChannelTurnSource[];
      disposition: "submitting" | "queued";
      removalDisposition?: "dequeued" | "cancelled";
    }
  >;
  active: ActiveGatewayTurn | null;
  registrationSignature: string | null;
  registration: Promise<void> | null;
  routedSources: ChannelTurnSource[];
  replayedControlRequestIds: Set<string>;
  submissionQueue: Promise<void>;
  hookQueue: Promise<void> | null;
  acceptedClientMessageIds: Set<string>;
  modelStatus: ChannelGatewayModelStatus | null;
};

function runtimeKey(runtime: RuntimeScope): string {
  return `${runtime.agent_id}:${runtime.conversation_id}`;
}

function hasAgentRuntime<
  T extends { runtime?: RuntimeScope<string | null> | null },
>(value: T): value is T & { runtime: RuntimeScope } {
  return !!value.runtime?.agent_id;
}

function sourceRouteKey(source: ChannelTurnSource): string {
  return [
    source.channel,
    source.accountId ?? "",
    source.chatId,
    source.threadId ?? "",
  ].join(":");
}

function sourceLifecycleKey(source: ChannelTurnSource): string {
  return [
    sourceRouteKey(source),
    source.messageId ?? "",
    source.agentId,
    source.conversationId,
  ].join(":");
}

function uniqueSourcesBy(
  sources: ChannelTurnSource[],
  getKey: (source: ChannelTurnSource) => string,
): ChannelTurnSource[] {
  const byKey = new Map<string, ChannelTurnSource>();
  for (const source of sources) byKey.set(getKey(source), source);
  return [...byKey.values()];
}

function uniqueRoutedSources(
  sources: ChannelTurnSource[],
): ChannelTurnSource[] {
  return uniqueSourcesBy(sources, sourceRouteKey);
}

function uniqueLifecycleSources(
  sources: ChannelTurnSource[],
): ChannelTurnSource[] {
  return uniqueSourcesBy(sources, sourceLifecycleKey);
}

function channelTagsForSources(sources: ChannelTurnSource[]): string[] {
  return [...new Set(sources.map((source) => `channel:${source.channel}`))];
}

function stopReasonFromDelta(
  message: StreamDeltaMessage,
): StopReasonType | null {
  const delta = message.delta;
  return delta.message_type === "stop_reason" &&
    "stop_reason" in delta &&
    typeof delta.stop_reason === "string"
    ? delta.stop_reason
    : null;
}

function runIdFromDelta(message: StreamDeltaMessage): string | undefined {
  const runId = "run_id" in message.delta ? message.delta.run_id : undefined;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

function lifecycleOutcome(
  stopReason: StopReasonType,
): "completed" | "error" | "cancelled" {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "end_turn" || stopReason === "tool_rule") {
    return "completed";
  }
  return "error";
}

/**
 * Process-neutral Channels bridge. It only speaks the public App Server
 * protocol; channel adapters and credentials stay behind the injected hooks.
 */
export class ChannelGateway {
  private readonly states = new Map<string, GatewayRuntimeState>();
  private readonly disposers: Array<() => void> = [];
  // Tool publication and runtime_start both replace the same connection-owned
  // registration. Keep them ordered so a late runtime_start cannot resurrect a
  // route that an overlapping route-removal update just revoked.
  private registrationQueue = Promise.resolve();

  constructor(
    private readonly client: ChannelGatewayClient,
    private readonly hooks: ChannelGatewayHooks,
  ) {
    this.disposers.push(
      client.onMessage((message) => this.handleMessage(message)),
      client.onExternalToolCall((request) => {
        const state = hasAgentRuntime(request)
          ? this.states.get(runtimeKey(request.runtime))
          : undefined;
        const active = state?.active;
        const sources = active?.routingSources ?? state?.routedSources ?? [];
        // Pass the per-turn idempotency scope only when a turn is active;
        // process-owned calls (no active batch) are not deduped.
        return hooks.executeExternalTool(
          request,
          sources,
          active?.idempotencyScope ?? null,
        );
      }),
    );
  }

  close(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.client.close();
    this.states.clear();
  }

  async submit(delivery: ChannelGatewayDelivery): Promise<boolean> {
    const state = this.getState(delivery.runtime);
    const submission = state.submissionQueue.then(() =>
      this.submitDelivery(state, delivery),
    );
    state.submissionQueue = submission.then(
      () => undefined,
      () => undefined,
    );
    return submission;
  }

  private async submitDelivery(
    state: GatewayRuntimeState,
    delivery: ChannelGatewayDelivery,
  ): Promise<boolean> {
    if (state.acceptedClientMessageIds.has(delivery.clientMessageId)) {
      state.acceptedClientMessageIds.delete(delivery.clientMessageId);
      state.acceptedClientMessageIds.add(delivery.clientMessageId);
      return true;
    }
    state.pendingSourcesByClientMessageId.set(delivery.clientMessageId, {
      sources: uniqueLifecycleSources(delivery.sources),
      disposition: "submitting",
    });
    try {
      await this.enqueueRegistration(async () => {
        state.routedSources = uniqueRoutedSources([
          ...state.routedSources,
          ...delivery.sources,
        ]);
        await this.performRuntimeRegistration(state, delivery);
      });
      const response = await this.client.submitInput({
        runtime: delivery.runtime,
        payload: {
          kind: "create_message",
          messages: [
            {
              role: "user",
              content: delivery.content,
              client_message_id: delivery.clientMessageId,
            },
          ],
          image_failure_mode: "drop",
        },
      });
      if (!response.accepted) {
        state.pendingSourcesByClientMessageId.delete(delivery.clientMessageId);
        return false;
      }
      this.rememberAcceptedClientMessageId(state, delivery.clientMessageId);
      const queuedEvents = delivery.sources.map((source) =>
        this.enqueueHook(state, () =>
          this.hooks.onLifecycle({ type: "queued", source }),
        ),
      );
      if (response.disposition === "started") {
        this.activateSources(state, delivery.clientMessageId, delivery.sources);
        state.pendingSourcesByClientMessageId.delete(delivery.clientMessageId);
      } else if (response.disposition === "queued") {
        const pending = state.pendingSourcesByClientMessageId.get(
          delivery.clientMessageId,
        );
        if (pending) {
          pending.disposition = "queued";
        }
        this.reconcileExplicitQueueRemovals(state);
      }
      await Promise.all(queuedEvents);
      return true;
    } catch (error) {
      state.pendingSourcesByClientMessageId.delete(delivery.clientMessageId);
      throw error;
    }
  }

  adoptQueuedDelivery(delivery: ChannelGatewayHandoffDelivery): void {
    const state = this.getState(delivery.runtime);
    const sources = uniqueLifecycleSources(delivery.sources);
    const pending = state.pendingSourcesByClientMessageId.get(
      delivery.clientMessageId,
    );
    if (pending) {
      const matches =
        pending.disposition === "queued" &&
        JSON.stringify(pending.sources) === JSON.stringify(sources);
      if (matches) return;
      throw new Error(
        `Cannot adopt queued delivery ${delivery.clientMessageId}; conflicting metadata exists`,
      );
    }
    if (
      state.acceptedClientMessageIds.has(delivery.clientMessageId) ||
      state.active?.batchId === `channel-${delivery.clientMessageId}`
    ) {
      throw new Error(
        `Cannot adopt queued delivery ${delivery.clientMessageId}; it is not queued`,
      );
    }
    state.pendingSourcesByClientMessageId.set(delivery.clientMessageId, {
      sources,
      disposition: "queued",
    });
    state.routedSources = uniqueRoutedSources([
      ...state.routedSources,
      ...delivery.sources,
    ]);
    this.rememberAcceptedClientMessageId(state, delivery.clientMessageId);
  }

  async restoreRuntime(
    runtime: RuntimeScope,
    sources: ChannelTurnSource[],
  ): Promise<Set<string>> {
    const state = this.getState(runtime);
    state.replayedControlRequestIds.clear();
    let recoveredTurn: ActiveGatewayTurn | null = null;
    if (!state.active) {
      recoveredTurn = {
        batchId: `channel-recovered-${crypto.randomUUID()}`,
        routingSources: uniqueRoutedSources(sources),
        lifecycleSources: uniqueLifecycleSources(sources),
        progress: createChannelTurnProgressBuilder(),
        richDraft: null,
        idempotencyScope: createMessageChannelIdempotencyScope(),
      };
      state.active = recoveredTurn;
    }
    try {
      await this.registerRuntime(runtime, sources);
    } catch (error) {
      if (state.active === recoveredTurn) state.active = null;
      throw error;
    }
    const replayedRequestIds = new Set(state.replayedControlRequestIds);
    if (replayedRequestIds.size === 0 && state.active === recoveredTurn) {
      state.active = null;
    }
    return replayedRequestIds;
  }

  /** Adopt an in-flight turn without submitting its user input again. */
  async adoptActiveDelivery(
    delivery: ChannelGatewayHandoffDelivery,
  ): Promise<void> {
    const key = runtimeKey(delivery.runtime);
    const stateExisted = this.states.has(key);
    const state = this.getState(delivery.runtime);
    const batchId = `channel-${delivery.clientMessageId}`;
    await this.enqueueRegistration(async () => {
      if (state.active) {
        if (state.active.batchId !== batchId) {
          throw new Error(
            `Cannot adopt ${batchId}; ${state.active.batchId} is already active`,
          );
        }
        this.activateSources(state, delivery.clientMessageId, delivery.sources);
        this.rememberAcceptedClientMessageId(state, delivery.clientMessageId);
        return;
      }

      const previousRoutedSources = state.routedSources;
      const wasAccepted = state.acceptedClientMessageIds.has(
        delivery.clientMessageId,
      );
      const routingSources = uniqueRoutedSources(delivery.sources);
      const active: ActiveGatewayTurn = {
        batchId,
        routingSources,
        lifecycleSources: uniqueLifecycleSources(delivery.sources),
        progress: createChannelTurnProgressBuilder(),
        richDraft: null,
        idempotencyScope: createMessageChannelIdempotencyScope(),
      };
      state.active = active;
      state.routedSources = uniqueRoutedSources([
        ...state.routedSources,
        ...delivery.sources,
      ]);
      this.rememberAcceptedClientMessageId(state, delivery.clientMessageId);
      try {
        await this.performRuntimeRegistration(state, {
          ...delivery,
          content: "",
        });
        if (state.active !== active) return;
        active.richDraft =
          this.hooks.createRichDraft?.({
            batchId,
            sources: routingSources,
          }) ?? null;
        await this.enqueueHook(state, () =>
          this.hooks.onLifecycle({
            type: "processing",
            batchId,
            sources: active.lifecycleSources,
          }),
        );
      } catch (error) {
        active.richDraft?.dispose();
        if (state.active === active) state.active = null;
        state.routedSources = previousRoutedSources;
        if (!wasAccepted) {
          state.acceptedClientMessageIds.delete(delivery.clientMessageId);
        }
        if (!stateExisted && state.active === null) this.states.delete(key);
        throw error;
      }
    });
  }

  /** Forget a handed-off turn silently; the caller then releases its tools. */
  releaseActiveDelivery(
    runtime: RuntimeScope,
    clientMessageId: string,
  ): boolean {
    const key = runtimeKey(runtime);
    const state = this.states.get(key);
    const active = state?.active;
    if (!state || active?.batchId !== `channel-${clientMessageId}`) {
      return false;
    }
    active.richDraft?.dispose();
    this.states.delete(key);
    return true;
  }

  async registerRuntime(
    runtime: RuntimeScope,
    sources: ChannelTurnSource[] = [],
    defaultPermissionMode?: ChannelDefaultPermissionMode,
  ): Promise<void> {
    const state = this.getState(runtime);
    await this.enqueueRegistration(async () => {
      this.setRoutedSources(runtime, sources);
      await this.performRuntimeRegistration(state, {
        runtime,
        content: "",
        sources,
        clientMessageId: "recovered",
        ...(defaultPermissionMode ? { defaultPermissionMode } : {}),
      });
    });
  }

  /** Publish tools for a listener-owned turn without subscribing to its stream. */
  async publishRuntimeTools(
    runtime: RuntimeScope,
    sources: ChannelTurnSource[] = [],
  ): Promise<boolean> {
    return await this.enqueueRegistration(async () => {
      if (this.states.has(runtimeKey(runtime))) return false;
      const tool = await this.hooks.buildExternalTool(runtime, sources);
      const response = await this.client.runtimeExternalToolsUpdate({
        updates: [
          {
            runtimes: [runtime],
            external_tools: tool ? [{ tools: [tool] }] : [],
          },
        ],
      });
      if (!response.success) {
        throw new Error(
          response.error ?? "Failed to publish channel runtime tools",
        );
      }
      return tool !== null;
    });
  }

  async releaseRuntimeTools(
    runtime: RuntimeScope,
    routedSources: ChannelTurnSource[] = [],
    options: { cleanupIdleRuntime?: boolean } = {},
  ): Promise<void> {
    await this.enqueueRegistration(async () => {
      const key = runtimeKey(runtime);
      const state = this.states.get(key);
      if (options.cleanupIdleRuntime) {
        if (
          routedSources.length > 0 ||
          (state?.routedSources.length ?? 0) > 0
        ) {
          throw new Error("Cannot clean up a routed channel runtime");
        }
        if (state?.active) {
          throw new Error("Cannot clean up an active channel runtime");
        }
        if ((state?.pendingSourcesByClientMessageId.size ?? 0) > 0) {
          throw new Error("Cannot clean up a queued channel runtime");
        }
        this.states.delete(key);
      } else if (routedSources.length > 0 || state) {
        return;
      }
      const response = await this.client.runtimeExternalToolsUpdate({
        updates: [{ runtimes: [runtime], external_tools: [] }],
      });
      if (!response.success) {
        throw new Error(
          response.error ?? "Failed to release channel runtime tools",
        );
      }
    });
  }

  async submitApprovalResponse(
    runtime: RuntimeScope,
    response: ApprovalResponseBody,
  ): Promise<boolean> {
    const result = await this.client.submitInput({
      runtime,
      payload: { kind: "approval_response", ...response },
    });
    return result.accepted;
  }

  setRoutedSources(runtime: RuntimeScope, sources: ChannelTurnSource[]): void {
    this.getState(runtime).routedSources = uniqueRoutedSources(sources);
  }

  getKnownRuntimes(): RuntimeScope[] {
    return [...this.states.values()].map((state) => state.runtime);
  }

  updateRoutedRuntimeTools(
    updates: readonly RuntimeExternalToolsUpdateGroup[],
    routedSources: Array<{
      runtime: RuntimeScope;
      sources: ChannelTurnSource[];
    }>,
  ): Promise<void> {
    return this.enqueueRegistration(async () => {
      if (updates.length > 0) {
        const response = await this.client.runtimeExternalToolsUpdate({
          updates,
        });
        if (!response.success) {
          throw new Error(
            response.error ?? "Failed to update routed runtime tools",
          );
        }
      }
      for (const update of routedSources) {
        this.setRoutedSources(update.runtime, update.sources);
      }
    });
  }

  getModelStatus(runtime: RuntimeScope): ChannelGatewayModelStatus | null {
    return this.states.get(runtimeKey(runtime))?.modelStatus ?? null;
  }

  updateModelStatus(runtime: RuntimeScope, modelHandle: string | null): void {
    const state = this.getState(runtime);
    state.modelStatus = {
      modelHandle,
      scope: runtime.conversation_id === "default" ? "agent" : "conversation",
    };
  }

  private getState(runtime: RuntimeScope): GatewayRuntimeState {
    const key = runtimeKey(runtime);
    let state = this.states.get(key);
    if (!state) {
      state = {
        runtime,
        pendingSourcesByClientMessageId: new Map(),
        active: null,
        registrationSignature: null,
        registration: null,
        routedSources: [],
        replayedControlRequestIds: new Set(),
        submissionQueue: Promise.resolve(),
        hookQueue: null,
        acceptedClientMessageIds: new Set(),
        modelStatus: null,
      };
      this.states.set(key, state);
    }
    return state;
  }

  private rememberAcceptedClientMessageId(
    state: GatewayRuntimeState,
    clientMessageId: string,
  ): void {
    state.acceptedClientMessageIds.delete(clientMessageId);
    state.acceptedClientMessageIds.add(clientMessageId);
    if (state.acceptedClientMessageIds.size <= MAX_ACCEPTED_CLIENT_MESSAGE_IDS)
      return;
    const oldest = state.acceptedClientMessageIds.values().next().value;
    if (oldest) state.acceptedClientMessageIds.delete(oldest);
  }

  private enqueueHook(
    state: GatewayRuntimeState,
    hook: () => void | Promise<void>,
  ): Promise<void> {
    let pending: Promise<void>;
    if (state.hookQueue) {
      pending = state.hookQueue.then(hook);
    } else {
      try {
        pending = Promise.resolve(hook());
      } catch (error) {
        pending = Promise.reject(error);
      }
    }
    const settled = pending.then(
      () => undefined,
      () => undefined,
    );
    state.hookQueue = settled;
    void settled.then(() => {
      if (state.hookQueue === settled) state.hookQueue = null;
    });
    return pending;
  }

  private enqueueRegistration<T>(task: () => Promise<T>): Promise<T> {
    const result = this.registrationQueue.then(task, task);
    this.registrationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async performRuntimeRegistration(
    state: GatewayRuntimeState,
    delivery: ChannelGatewayDelivery,
  ): Promise<void> {
    const tool = await this.hooks.buildExternalTool(
      delivery.runtime,
      delivery.sources,
    );
    const conversationTags = channelTagsForSources(delivery.sources);
    const signature = JSON.stringify({
      mode: delivery.defaultPermissionMode ?? null,
      tool,
      conversationTags,
    });
    if (state.registrationSignature === signature && state.registration) {
      return state.registration;
    }

    const registration = this.client
      .runtimeStart({
        agent_id: delivery.runtime.agent_id,
        conversation_id: delivery.runtime.conversation_id,
        ...(conversationTags.length > 0
          ? { conversation_source_tags: conversationTags }
          : {}),
        ...(delivery.defaultPermissionMode
          ? { mode: delivery.defaultPermissionMode }
          : {}),
        recover_approvals: true,
        force_device_status: false,
        wait_for_replay: true,
        preserve_skill_sources: true,
        client_info: { name: "channel-gateway", title: "Channel Gateway" },
        external_tools: tool ? [{ tools: [tool] }] : [],
      })
      .then((response) => {
        if (!response.success) {
          throw new Error(
            response.error ?? "Failed to register channel runtime",
          );
        }
        const agentRecord = response.agent as unknown as Record<
          string,
          unknown
        > | null;
        const conversationRecord = response.conversation as unknown as Record<
          string,
          unknown
        > | null;
        const agentModel =
          typeof agentRecord?.model === "string"
            ? agentRecord.model
            : (response.agent?.llm_config?.model ?? null);
        const conversationModel =
          typeof conversationRecord?.model === "string"
            ? conversationRecord.model
            : null;
        state.modelStatus = {
          modelHandle:
            delivery.runtime.conversation_id === "default"
              ? agentModel
              : (conversationModel ?? agentModel),
          scope:
            delivery.runtime.conversation_id === "default"
              ? "agent"
              : "conversation",
        };
      });
    state.registrationSignature = signature;
    state.registration = registration;
    try {
      await registration;
    } catch (error) {
      if (state.registration === registration) {
        state.registration = null;
        state.registrationSignature = null;
      }
      throw error;
    }
  }

  private handleMessage(message: WsProtocolMessage): void {
    if (message.type === "update_queue") {
      if (hasAgentRuntime(message)) this.handleQueueUpdate(message);
      return;
    }
    if (message.type === "stream_delta") {
      if (hasAgentRuntime(message)) this.handleStreamDelta(message);
      return;
    }
    if (message.type === "turn_finished") {
      if (!hasAgentRuntime(message)) return;
      this.handleTurnFinished(message.runtime, {
        stopReason: message.stop_reason,
        runId: message.run_id,
        error: message.error,
      });
      return;
    }
    if (message.type === "control_request") {
      this.handleControlRequest(message);
    }
  }

  private handleQueueUpdate(
    message: QueueUpdateMessage & { runtime: RuntimeScope },
  ): void {
    const state = this.getState(message.runtime);
    for (const transition of message.removed) {
      const pending = state.pendingSourcesByClientMessageId.get(
        transition.client_message_id,
      );
      if (pending) {
        pending.removalDisposition = transition.disposition;
      }
    }
    this.reconcileExplicitQueueRemovals(state);
  }

  private reconcileExplicitQueueRemovals(state: GatewayRuntimeState): void {
    const dequeued: Array<{
      clientMessageId: string;
      sources: ChannelTurnSource[];
    }> = [];
    const cancelled: Array<{
      clientMessageId: string;
      sources: ChannelTurnSource[];
    }> = [];

    for (const [
      clientMessageId,
      pending,
    ] of state.pendingSourcesByClientMessageId) {
      if (pending.disposition !== "queued" || !pending.removalDisposition) {
        continue;
      }
      const target =
        pending.removalDisposition === "dequeued" ? dequeued : cancelled;
      target.push({ clientMessageId, sources: pending.sources });
      state.pendingSourcesByClientMessageId.delete(clientMessageId);
    }

    const firstDequeued = dequeued[0];
    if (firstDequeued) {
      this.activateSources(
        state,
        firstDequeued.clientMessageId,
        dequeued.flatMap((entry) => entry.sources),
      );
    }
    for (const entry of cancelled) {
      void this.enqueueHook(state, () =>
        this.hooks.onLifecycle({
          type: "finished",
          batchId: `channel-${entry.clientMessageId}`,
          sources: entry.sources,
          outcome: "cancelled",
          stopReason: "cancelled",
        }),
      );
    }
  }

  private activateSources(
    state: GatewayRuntimeState,
    clientMessageId: string,
    sources: ChannelTurnSource[],
  ): void {
    if (state.active) {
      const knownLifecycleKeys = new Set(
        state.active.lifecycleSources.map(sourceLifecycleKey),
      );
      const addedLifecycleSources = uniqueLifecycleSources(sources).filter(
        (source) => !knownLifecycleKeys.has(sourceLifecycleKey(source)),
      );
      if (addedLifecycleSources.length === 0) return;
      state.active.lifecycleSources = uniqueLifecycleSources([
        ...state.active.lifecycleSources,
        ...addedLifecycleSources,
      ]);
      state.active.routingSources = uniqueRoutedSources([
        ...state.active.routingSources,
        ...sources,
      ]);
      const processingEvent: ChannelTurnLifecycleEvent = {
        type: "processing",
        batchId: state.active.batchId,
        sources: addedLifecycleSources,
      };
      void this.enqueueHook(state, () =>
        this.hooks.onLifecycle(processingEvent),
      );
      return;
    }
    const routingSources = uniqueRoutedSources(sources);
    const lifecycleSources = uniqueLifecycleSources(sources);
    state.active = {
      batchId: `channel-${clientMessageId}`,
      routingSources,
      lifecycleSources,
      progress: createChannelTurnProgressBuilder(),
      richDraft:
        this.hooks.createRichDraft?.({
          batchId: `channel-${clientMessageId}`,
          sources: routingSources,
        }) ?? null,
      idempotencyScope: createMessageChannelIdempotencyScope(),
    };
    const processingEvent: ChannelTurnLifecycleEvent = {
      type: "processing",
      batchId: state.active.batchId,
      sources: state.active.lifecycleSources,
    };
    void this.enqueueHook(state, () => this.hooks.onLifecycle(processingEvent));
  }

  private handleStreamDelta(
    message: StreamDeltaMessage & { runtime: RuntimeScope },
  ): void {
    if (message.subagent_id) return;
    const state = this.getState(message.runtime);
    const active = state.active;
    if (!active) return;

    const runId = runIdFromDelta(message);
    if (runId) active.runId = runId;
    for (const update of active.progress.buildUpdates(message.delta)) {
      void this.enqueueHook(state, () =>
        this.hooks.onProgress({
          type: "progress",
          batchId: active.batchId,
          sources: active.routingSources,
          ...update,
        }),
      );
    }
    active.richDraft?.handleDelta(message.delta);

    const stopReason = stopReasonFromDelta(message);
    if (stopReason === "requires_approval" || stopReason === "end_turn") {
      void active.richDraft?.flushPending();
    }
    // The listener sends a canonical turn_finished event after it classifies
    // terminal failures. Finalizing from this earlier delta would discard that
    // user-safe error detail.
  }

  private handleTurnFinished(
    runtime: RuntimeScope,
    terminal: {
      stopReason: StopReasonType;
      runId?: string;
      error?: string;
    },
  ): void {
    const state = this.getState(runtime);
    const active = state.active;
    if (!active) return;
    state.active = null;
    active.richDraft?.dispose();
    void this.enqueueHook(state, () =>
      this.hooks.onLifecycle({
        type: "finished",
        batchId: active.batchId,
        sources: active.lifecycleSources,
        outcome: lifecycleOutcome(terminal.stopReason),
        stopReason: terminal.stopReason,
        ...((terminal.runId ?? active.runId)
          ? { runId: terminal.runId ?? active.runId }
          : {}),
        ...(terminal.error ? { error: terminal.error } : {}),
      }),
    );
  }

  private handleControlRequest(message: ControlRequest): void {
    if (!message.agent_id || !message.conversation_id) return;
    const state = this.states.get(
      runtimeKey({
        agent_id: message.agent_id,
        conversation_id: message.conversation_id,
      }),
    );
    if (!state) return;
    const sources = state.active?.routingSources ?? [];
    state.replayedControlRequestIds.add(message.request_id);
    const sourceScopes = new Map(
      sources.map((source) => [sourceRouteKey(source), source]),
    );
    if (sourceScopes.size !== 1) return;
    const source = [...sourceScopes.values()][0];
    if (!source) return;
    void this.enqueueHook(state, () =>
      this.hooks.onControlRequest({
        requestId: message.request_id,
        kind:
          getInteractiveApprovalKind(message.request.tool_name) ??
          "generic_tool_approval",
        source,
        toolName: message.request.tool_name,
        input: message.request.input,
      }),
    );
  }
}
