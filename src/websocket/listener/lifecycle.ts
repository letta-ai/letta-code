import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import WebSocket from "ws";
import { getChannelRegistry } from "../../channels/registry";
import type { ChannelTurnSource } from "../../channels/types";
import { setMessageQueueAdder } from "../../cli/helpers/messageQueueBridge";
import {
  getSubagents,
  subscribe as subscribeToSubagentState,
  subscribeToStreamEvents as subscribeToSubagentStreamEvents,
} from "../../cli/helpers/subagentState";
import {
  startScheduler as startCronScheduler,
  stopScheduler as stopCronScheduler,
} from "../../cron/scheduler";
import type { DequeuedBatch } from "../../queue/queueRuntime";
import { createSharedReminderState } from "../../reminders/state";
import { getCurrentWorkingDirectory } from "../../runtime-context";
import { settingsManager } from "../../settings-manager";
import { telemetry } from "../../telemetry";
import { trackBoundaryError } from "../../telemetry/errorReporting";
import { loadTools } from "../../tools/manager";
import { isDebugEnabled } from "../../utils/debug";
import { killAllTerminals } from "../terminalHandler";
import { rejectPendingApprovalResolvers } from "./approval";
import { handleChannelRegistryEvent } from "./commands/channels";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  MAX_RETRY_DURATION_MS,
} from "./constants";
import {
  handleAbortMessageInput,
  handleApprovalResponseInput,
  handleChangeDeviceStateInput,
} from "./control-inputs";
import {
  ensureConversationQueueRuntime,
  findFallbackRuntime,
  getOrCreateScopedRuntime,
} from "./conversation-runtime";
import { loadPersistedCwdMap } from "./cwd";
import { createFileCommandSession } from "./file-commands";
import { createListenerMessageHandler } from "./message-router";
import { loadPersistedPermissionModeMap } from "./permissionMode";
import {
  emitDeviceStatusUpdate,
  emitLoopStatusUpdate,
  emitStateSync,
  emitStreamDelta,
  emitSubagentStateIfOpen,
} from "./protocol-outbound";
import { scheduleQueuePump } from "./queue";
import { recoverApprovalStateForSync } from "./recovery";
import {
  clearConversationRuntimeState,
  clearRuntimeTimers,
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
  getOrCreateConversationRuntime,
  getRecoveredApprovalStateForScope,
  safeEmitWsEvent,
  setActiveRuntime,
} from "./runtime";
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
  LocalListenerTransport,
} from "./transport";
import { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";
import {
  clearListenerWarmState,
  scheduleListenerWarmupsAfterSync,
} from "./warmup";
import { stopAllWorktreeWatchers } from "./worktree-watcher";

function trackListenerError(
  errorType: string,
  error: unknown,
  context: string,
): void {
  trackBoundaryError({
    errorType,
    error,
    context,
  });
}

export function safeSocketSend(
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    socket.send(serialized);
    return true;
  } catch (error) {
    trackListenerError(errorType, error, context);
    if (isDebugEnabled()) {
      console.error(`[Listen] ${context} send failed:`, error);
    }
    return false;
  }
}

function safeTransportSend(
  transport: ListenerTransport,
  payload: unknown,
  errorType: string,
  context: string,
): boolean {
  if (!isListenerTransportOpen(transport)) {
    return false;
  }

  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    transport.send(serialized);
    return true;
  } catch (error) {
    trackListenerError(errorType, error, context);
    if (isDebugEnabled()) {
      console.error(`[Listen] ${context} send failed:`, error);
    }
    return false;
  }
}

export function runDetachedListenerTask(
  commandName: string,
  task: () => Promise<void>,
): void {
  void task().catch((error) => {
    trackListenerError(
      `listener_${commandName}_failed`,
      error,
      `listener_${commandName}`,
    );
    if (isDebugEnabled()) {
      console.error(`[Listen] ${commandName} failed:`, error);
    }
  });
}

export async function replaySyncStateForRuntime(
  listenerRuntime: ListenerRuntime,
  socket: WebSocket,
  scope: { agent_id: string; conversation_id: string },
  opts?: {
    recoverApprovals?: boolean;
    recoverApprovalStateForSync?: (
      runtime: ConversationRuntime,
      scope: { agent_id: string; conversation_id: string },
    ) => Promise<void>;
    scheduleWarmupsAfterSync?: (
      runtime: ListenerRuntime,
      scope: { agent_id: string; conversation_id: string },
    ) => void;
  },
): Promise<void> {
  const syncScopedRuntime = getOrCreateScopedRuntime(
    listenerRuntime,
    scope.agent_id,
    scope.conversation_id,
  );
  const recoverFn =
    opts?.recoverApprovalStateForSync ?? recoverApprovalStateForSync;

  if (opts?.recoverApprovals ?? true) {
    try {
      await recoverFn(syncScopedRuntime, scope);
    } catch (error) {
      trackListenerError(
        "listener_sync_recovery_failed",
        error,
        "listener_sync_recovery",
      );
      if (isDebugEnabled()) {
        console.warn("[Listen] Sync approval recovery failed:", error);
      }
    }
  }

  emitStateSync(socket, listenerRuntime, scope);
  (opts?.scheduleWarmupsAfterSync ?? scheduleListenerWarmupsAfterSync)(
    listenerRuntime,
    scope,
  );
}

export async function recoverPendingChannelControlRequests(
  listener: ListenerRuntime,
  opts?: {
    recoverApprovalStateForSync?: (
      runtime: ConversationRuntime,
      scope: { agent_id: string; conversation_id: string },
    ) => Promise<void>;
  },
): Promise<void> {
  const registry = getChannelRegistry();
  if (!registry) {
    return;
  }

  const pendingEntries = registry.getPendingControlRequests();
  if (pendingEntries.length === 0) {
    return;
  }

  const recoverFn =
    opts?.recoverApprovalStateForSync ?? recoverApprovalStateForSync;
  const entriesByScope = new Map<
    string,
    {
      scope: { agent_id: string; conversation_id: string };
      entries: typeof pendingEntries;
    }
  >();

  for (const entry of pendingEntries) {
    const scope = {
      agent_id: entry.event.source.agentId,
      conversation_id: entry.event.source.conversationId,
    };
    const scopeKey = `${scope.agent_id}:${scope.conversation_id}`;
    const existing = entriesByScope.get(scopeKey);
    if (existing) {
      existing.entries.push(entry);
      continue;
    }
    entriesByScope.set(scopeKey, {
      scope,
      entries: [entry],
    });
  }

  for (const { scope, entries } of entriesByScope.values()) {
    const runtime = getOrCreateScopedRuntime(
      listener,
      scope.agent_id,
      scope.conversation_id,
    );
    const livePendingRequestIds = new Set(
      runtime.pendingApprovalResolvers.keys(),
    );
    const shouldRecoverFromBackend = entries.some(
      (entry) => !livePendingRequestIds.has(entry.event.requestId),
    );

    if (shouldRecoverFromBackend) {
      try {
        await recoverFn(runtime, scope);
      } catch (error) {
        trackListenerError(
          "listener_channel_control_request_recovery_failed",
          error,
          "listener_channel_control_request_recovery",
        );
        if (isDebugEnabled()) {
          console.warn(
            "[Listen] Channel control request recovery failed:",
            error,
          );
        }
        continue;
      }
    }

    const recoveredPendingRequestIds =
      getRecoveredApprovalStateForScope(listener, scope)?.pendingRequestIds ??
      new Set<string>();

    for (const entry of entries) {
      const requestId = entry.event.requestId;
      const stillPending =
        livePendingRequestIds.has(requestId) ||
        recoveredPendingRequestIds.has(requestId);

      if (!stillPending) {
        registry.clearPendingControlRequest(requestId);
        continue;
      }

      if (entry.deliveredThisProcess) {
        continue;
      }

      await registry.redeliverPendingControlRequest(requestId);
    }
  }
}

function getParsedRuntimeScope(
  parsed: unknown,
): { agent_id: string; conversation_id: string } | null {
  if (!parsed || typeof parsed !== "object" || !("runtime" in parsed)) {
    return null;
  }

  const runtime = (
    parsed as {
      runtime?: { agent_id?: unknown; conversation_id?: unknown };
    }
  ).runtime;
  if (!runtime || typeof runtime.agent_id !== "string") {
    return null;
  }

  return {
    agent_id: runtime.agent_id,
    conversation_id:
      typeof runtime.conversation_id === "string"
        ? runtime.conversation_id
        : "default",
  };
}

/**
 * Wire channel ingress into the listener.
 *
 * Registers the ChannelRegistry's message handler and marks it as ready,
 * allowing buffered and future inbound channel messages to flow through
 * the queue pump.
 *
 * Called from the socket "open" handler - same pattern as startCronScheduler.
 * Uses closure-scoped socket/opts/processQueuedTurn.
 */
export async function wireChannelIngress(
  listener: ListenerRuntime,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): Promise<void> {
  const registry = getChannelRegistry();
  if (!registry) return;

  registry.setMessageHandler((delivery) => {
    // Follow the same pattern as cron/scheduler.ts:131-157
    const rawRuntime = getOrCreateConversationRuntime(
      listener,
      delivery.route.agentId,
      delivery.route.conversationId,
    );
    if (!rawRuntime) return;

    const conversationRuntime = ensureConversationQueueRuntime(
      listener,
      rawRuntime,
    );

    const enqueuedItem = enqueueChannelTurn(
      conversationRuntime,
      delivery.route,
      delivery.content,
      delivery.turnSources,
    );
    if (!enqueuedItem) {
      return;
    }

    for (const turnSource of delivery.turnSources ?? []) {
      void registry.dispatchTurnLifecycleEvent({
        type: "queued",
        source: turnSource,
      });
    }

    scheduleQueuePump(conversationRuntime, socket, opts, processQueuedTurn);
  });

  registry.setEventHandler((event) => {
    handleChannelRegistryEvent(event, socket, listener, safeSocketSend);
  });

  await recoverPendingChannelControlRequests(listener);

  registry.setApprovalResponseHandler(async ({ runtime, response }) =>
    handleApprovalResponseInput(listener, {
      runtime,
      response,
      socket,
      opts,
      processQueuedTurn,
    }),
  );

  registry.setReady();
}

function stampInboundUserMessageOtids(
  incoming: IncomingMessage,
): IncomingMessage {
  let didChange = false;
  const messages = incoming.messages.map((payload) => {
    if (!("content" in payload) || payload.otid) {
      return payload;
    }

    didChange = true;
    return {
      ...payload,
      otid:
        "client_message_id" in payload &&
        typeof payload.client_message_id === "string"
          ? payload.client_message_id
          : crypto.randomUUID(),
    } satisfies MessageCreate & { client_message_id?: string };
  });

  if (!didChange) {
    return incoming;
  }

  return {
    ...incoming,
    messages,
  };
}

export function enqueueChannelTurn(
  runtime: ConversationRuntime,
  route: {
    agentId: string;
    conversationId: string;
  },
  messageContent: MessageCreate["content"],
  turnSources?: ChannelTurnSource[],
): { id: string } | null {
  const clientMessageId = `cm-channel-${crypto.randomUUID()}`;
  const enqueuedItem = runtime.queueRuntime.enqueue({
    kind: "message",
    source: "channel" as import("../../types/protocol").QueueItemSource,
    content: messageContent,
    clientMessageId,
    agentId: route.agentId,
    conversationId: route.conversationId,
  } as Omit<
    import("../../queue/queueRuntime").MessageQueueItem,
    "id" | "enqueuedAt"
  >);

  if (!enqueuedItem) {
    return null;
  }

  runtime.queuedMessagesByItemId.set(
    enqueuedItem.id,
    stampInboundUserMessageOtids({
      type: "message",
      agentId: route.agentId,
      conversationId: route.conversationId,
      ...(turnSources?.length ? { channelTurnSources: turnSources } : {}),
      messages: [
        {
          role: "user",
          content: messageContent,
          client_message_id: clientMessageId,
        } satisfies MessageCreate & { client_message_id?: string },
      ],
    }),
  );

  return enqueuedItem;
}

export function createRuntime(): ListenerRuntime {
  const bootWorkingDirectory = getCurrentWorkingDirectory();
  return {
    socket: null,
    transport: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: false,
    everConnected: false,
    sessionId: `listen-${crypto.randomUUID()}`,
    eventSeqCounter: 0,
    lastStopReason: null,
    queueEmitScheduled: false,
    pendingQueueEmitScope: undefined,
    onWsEvent: undefined,
    reminderState: createSharedReminderState(),
    bootWorkingDirectory,
    workingDirectoryByConversation: loadPersistedCwdMap(),
    worktreeWatcherByConversation: new Map(),
    permissionModeByConversation: loadPersistedPermissionModeMap(),
    reminderStateByConversation: new Map(),
    contextTrackerByConversation: new Map(),
    systemPromptRecompileByConversation: new Map(),
    queuedSystemPromptRecompileByConversation: new Set(),
    connectionId: null,
    connectionName: null,
    conversationRuntimes: new Map(),
    approvalRuntimeKeyByRequestId: new Map(),
    memfsSyncedAgents: new Map(),
    secretsHydrationByAgent: new Map(),
    secretsHydrationFreshnessByAgent: new Map(),
    secretsDirtyAgents: new Set(),
    agentMetadataByAgent: new Map(),
    lastEmittedStatus: null,
  };
}

export function stopRuntime(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  setMessageQueueAdder(null); // Clear bridge for ALL stop paths
  runtime.intentionallyClosed = true;
  clearRuntimeTimers(runtime);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    rejectPendingApprovalResolvers(
      conversationRuntime,
      "Listener runtime stopped",
    );
    clearConversationRuntimeState(conversationRuntime);
    if (conversationRuntime.queueRuntime) {
      conversationRuntime.queuedMessagesByItemId.clear();
      conversationRuntime.queueRuntime.clear("shutdown");
    }
  }
  runtime.conversationRuntimes.clear();
  runtime.approvalRuntimeKeyByRequestId.clear();
  clearListenerWarmState(runtime);
  runtime.reminderStateByConversation.clear();
  runtime.contextTrackerByConversation.clear();
  runtime.systemPromptRecompileByConversation.clear();
  runtime.queuedSystemPromptRecompileByConversation.clear();
  stopAllWorktreeWatchers(runtime);

  if (!runtime.socket) {
    runtime.transport = null;
    return;
  }

  const socket = runtime.socket;
  runtime.socket = null;
  runtime.transport = null;

  // Stale runtimes being replaced should not emit callbacks/retries.
  if (suppressCallbacks) {
    socket.removeAllListeners();
  }

  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

export async function startConnectedListenerRuntime(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  opts: Pick<
    StartListenerOptions,
    "connectionId" | "onConnected" | "onStatusChange" | "onWsEvent"
  >,
  processQueuedTurn: ProcessQueuedTurn,
  options: {
    startHeartbeat?: boolean;
    startCronScheduler?: boolean;
  } = {},
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    return;
  }

  const shouldStartHeartbeat = options.startHeartbeat !== false;
  // LETTA_DISABLE_CRON_SCHEDULER=1 lets users opt out entirely. Useful when
  // running multiple letta-code instances against the same agent dir, since
  // only one process can hold the lease and the others would otherwise log
  // "scheduler lease held by PID ..." on every connect.
  const cronSchedulerDisabledByEnv =
    process.env.LETTA_DISABLE_CRON_SCHEDULER === "1";
  const shouldStartCronScheduler =
    options.startCronScheduler !== false && !cronSchedulerDisabledByEnv;

  runtime.transport = transport;
  safeEmitWsEvent("recv", "lifecycle", {
    type:
      getListenerTransportKind(transport) === "websocket"
        ? "_ws_open"
        : "_local_open",
  });
  runtime.hasSuccessfulConnection = true;
  runtime.everConnected = true;
  opts.onConnected(opts.connectionId);

  if (runtime.conversationRuntimes.size === 0) {
    // Don't emit device_status before the lookup store exists.
    // Without a conversation runtime, the scope resolves to
    // agent:__unknown__ which misses persisted CWD and permission
    // mode entries. The web's sync command will create a scoped
    // runtime and emit a properly-scoped device_status at that point.
    emitLoopStatusUpdate(transport, runtime);
  } else {
    // Preserve existing per-conversation reminder and context state across
    // pure transport reconnects; only refresh the live status snapshots here.
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      const scope = {
        agent_id: conversationRuntime.agentId,
        conversation_id: conversationRuntime.conversationId,
      };
      emitDeviceStatusUpdate(transport, conversationRuntime, scope);
      emitLoopStatusUpdate(transport, conversationRuntime, scope);
    }
  }

  // Subscribe to subagent state changes and emit snapshots over the listener
  // transport. Local channel mode intentionally discards these frames.
  runtime._unsubscribeSubagentState?.();
  runtime._unsubscribeSubagentState = subscribeToSubagentState(() => {
    if (runtime.conversationRuntimes.size === 0) {
      emitSubagentStateIfOpen(runtime);
      return;
    }

    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      emitSubagentStateIfOpen(runtime, {
        agent_id: conversationRuntime.agentId,
        conversation_id: conversationRuntime.conversationId,
      });
    }
  });

  // Subscribe to subagent stream events and forward as tagged stream_delta.
  runtime._unsubscribeSubagentStreamEvents?.();
  runtime._unsubscribeSubagentStreamEvents = subscribeToSubagentStreamEvents(
    (subagentId, event) => {
      if (!isListenerTransportOpen(transport)) return;

      const subagent = getSubagents().find((entry) => entry.id === subagentId);
      if (subagent?.silent === true) {
        // Reflection/background "silent" subagents should not stream their
        // internal transcript into the parent conversation.
        return;
      }

      // The event has { type: "message", message_type, ...LettaStreamingResponse }
      // plus extra headless fields (session_id, uuid) that pass through harmlessly.
      emitStreamDelta(
        transport,
        runtime,
        event as unknown as import("../../types/protocol_v2").StreamDelta,
        subagent?.parentAgentId
          ? {
              agent_id: subagent.parentAgentId,
              conversation_id: subagent.parentConversationId ?? "default",
            }
          : undefined,
        subagentId,
      );
    },
  );

  // Register the message queue bridge to route task notifications into the
  // correct per-conversation QueueRuntime. This enables background Task
  // completions to reach the agent in listen mode.
  setMessageQueueAdder((queuedMessage) => {
    const targetRuntime =
      queuedMessage.agentId && queuedMessage.conversationId
        ? getOrCreateScopedRuntime(
            runtime,
            queuedMessage.agentId,
            queuedMessage.conversationId,
          )
        : findFallbackRuntime(runtime);

    if (!targetRuntime?.queueRuntime) {
      return; // No target - notification dropped
    }

    targetRuntime.queueRuntime.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: queuedMessage.text,
      agentId: queuedMessage.agentId ?? targetRuntime.agentId ?? undefined,
      conversationId:
        queuedMessage.conversationId ?? targetRuntime.conversationId,
    } as Omit<
      import("../../queue/queueRuntime").TaskNotificationQueueItem,
      "id" | "enqueuedAt"
    >);

    // Kick the queue pump so the notification can trigger a standalone turn
    // (see consumeQueuedTurn notification-aware path in queue.ts).
    scheduleQueuePump(
      targetRuntime,
      transport,
      opts as StartListenerOptions,
      processQueuedTurn,
    );
  });

  if (shouldStartHeartbeat) {
    runtime.heartbeatInterval = setInterval(() => {
      safeTransportSend(
        transport,
        { type: "ping" },
        "listener_ping_send_failed",
        "listener_heartbeat",
      );
    }, 30000);
  }

  if (shouldStartCronScheduler) {
    startCronScheduler(
      transport,
      opts as StartListenerOptions,
      processQueuedTurn,
    );
  }

  // Wire channel ingress (if channels are active).
  await wireChannelIngress(
    runtime,
    transport,
    opts as StartListenerOptions,
    processQueuedTurn,
  );
}

/**
 * Start the listener WebSocket client with automatic retry.
 */
export async function startListenerClient(
  opts: StartListenerOptions,
): Promise<void> {
  // Replace any existing runtime without stale callback leakage.
  const existingRuntime = getActiveRuntime();
  if (existingRuntime) {
    stopRuntime(existingRuntime, true);
  }

  const runtime = createRuntime();
  runtime.onWsEvent = opts.onWsEvent;
  runtime.connectionId = opts.connectionId;
  runtime.connectionName = opts.connectionName;
  setActiveRuntime(runtime);
  telemetry.setSurface("websocket");
  telemetry.init();

  await connectWithRetry(runtime, opts);
}

export interface StartLocalChannelListenerOptions {
  connectionId: string;
  deviceId: string;
  connectionName: string;
  onConnected: (connectionId: string) => void;
  onError: (error: Error) => void;
  onStatusChange?: StartListenerOptions["onStatusChange"];
  onWsEvent?: StartListenerOptions["onWsEvent"];
}

/**
 * Start a listener runtime for local channel adapters without environment
 * registration or a remote WebSocket server.
 */
export async function startLocalChannelListener(
  opts: StartLocalChannelListenerOptions,
): Promise<void> {
  const existingRuntime = getActiveRuntime();
  if (existingRuntime) {
    stopRuntime(existingRuntime, true);
  }

  const runtime = createRuntime();
  runtime.onWsEvent = opts.onWsEvent;
  runtime.connectionId = opts.connectionId;
  runtime.connectionName = opts.connectionName;
  setActiveRuntime(runtime);
  telemetry.setSurface("websocket");
  telemetry.init();

  try {
    await loadTools();
    const transport = new LocalListenerTransport();
    const processQueuedTurn: ProcessQueuedTurn = async (
      queuedTurn: IncomingMessage,
      dequeuedBatch: DequeuedBatch,
    ): Promise<void> => {
      const scopedRuntime = getOrCreateScopedRuntime(
        runtime,
        queuedTurn.agentId,
        queuedTurn.conversationId,
      );
      await handleIncomingMessage(
        queuedTurn,
        transport,
        scopedRuntime,
        opts.onStatusChange,
        opts.connectionId,
        dequeuedBatch.batchId,
      );
    };

    await startConnectedListenerRuntime(
      runtime,
      transport,
      opts,
      processQueuedTurn,
      { startHeartbeat: false, startCronScheduler: true },
    );
  } catch (error) {
    stopRuntime(runtime, true);
    if (getActiveRuntime() === runtime) {
      setActiveRuntime(null);
    }
    opts.onError(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Connect to WebSocket with exponential backoff retry.
 */
async function connectWithRetry(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
  attempt: number = 0,
  startTime: number = Date.now(),
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    return;
  }

  const elapsedTime = Date.now() - startTime;

  if (attempt > 0) {
    if (elapsedTime >= MAX_RETRY_DURATION_MS) {
      // If we ever had a successful connection, try to re-register instead
      // of giving up. This keeps established sessions alive through transient
      // outages (e.g. Cloudflare 521, server deploys).
      if (runtime.everConnected && opts.onNeedsReregister) {
        opts.onNeedsReregister();
        return;
      }
      opts.onError(new Error("Failed to connect after 5 minutes of retrying"));
      return;
    }

    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
    const maxAttempts = Math.ceil(
      Math.log2(MAX_RETRY_DURATION_MS / INITIAL_RETRY_DELAY_MS),
    );

    opts.onRetrying?.(attempt, maxAttempts, delay, opts.connectionId);

    await new Promise<void>((resolve) => {
      runtime.reconnectTimeout = setTimeout(resolve, delay);
    });

    runtime.reconnectTimeout = null;
    if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
      return;
    }
  }

  clearRuntimeTimers(runtime);

  if (attempt === 0) {
    await loadTools();
  }

  const settings = await settingsManager.getSettingsWithSecureTokens();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY");
  }

  const url = new URL(opts.wsUrl);
  url.searchParams.set("deviceId", opts.deviceId);
  url.searchParams.set("connectionName", opts.connectionName);

  const socket = new WebSocket(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const fileCommandSession = createFileCommandSession({
    socket,
    safeSocketSend,
    runDetachedListenerTask,
  });

  runtime.socket = socket;
  const transport = socket;
  const processQueuedTurn: ProcessQueuedTurn = async (
    queuedTurn: IncomingMessage,
    dequeuedBatch: DequeuedBatch,
  ): Promise<void> => {
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      queuedTurn.agentId,
      queuedTurn.conversationId,
    );
    await handleIncomingMessage(
      queuedTurn,
      transport,
      scopedRuntime,
      opts.onStatusChange,
      opts.connectionId,
      dequeuedBatch.batchId,
    );
  };

  socket.on("open", async () => {
    await startConnectedListenerRuntime(
      runtime,
      transport,
      opts,
      processQueuedTurn,
      { startHeartbeat: true, startCronScheduler: true },
    );
  });

  socket.on(
    "message",
    createListenerMessageHandler({
      runtime,
      socket,
      opts,
      processQueuedTurn,
      fileCommandSession,
      getParsedRuntimeScope,
      replaySyncStateForRuntime,
      getOrCreateScopedRuntime,
      handleApprovalResponseInput,
      handleChangeDeviceStateInput,
      handleAbortMessageInput,
      stampInboundUserMessageOtids,
      safeSocketSend,
      runDetachedListenerTask,
      trackListenerError,
      wireChannelIngress,
    }),
  );

  socket.on("close", (code: number, reason: Buffer) => {
    if (runtime !== getActiveRuntime()) {
      return;
    }

    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_close",
      code,
      reason: reason.toString(),
    });

    fileCommandSession.dispose();

    // Stop cron scheduler on disconnect
    stopCronScheduler();

    // Pause channel delivery on disconnect (adapters keep polling, messages buffer).
    // On reconnect, wireChannelIngress() re-registers the handler and calls setReady().
    const channelRegistry = getChannelRegistry();
    if (channelRegistry) {
      channelRegistry.pause();
    }

    // Clear the bridge before queue clearing to prevent a race where a task
    // completion enqueues into a shutting-down runtime.
    setMessageQueueAdder(null);

    // Single authoritative queue clear for all close paths
    // (intentional and unintentional). Must fire before early returns.
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      conversationRuntime.queuedMessagesByItemId.clear();
      if (conversationRuntime.queueRuntime) {
        conversationRuntime.queueRuntime.clear("shutdown");
      }
    }

    if (isDebugEnabled()) {
      console.log(
        `[Listen] WebSocket disconnected (code: ${code}, reason: ${reason.toString()})`,
      );
    }

    clearRuntimeTimers(runtime);
    killAllTerminals();
    runtime._unsubscribeSubagentState?.();
    runtime._unsubscribeSubagentState = undefined;
    runtime._unsubscribeSubagentStreamEvents?.();
    runtime._unsubscribeSubagentStreamEvents = undefined;
    clearListenerWarmState(runtime);
    runtime.socket = null;
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      rejectPendingApprovalResolvers(
        conversationRuntime,
        "WebSocket disconnected",
      );
      clearConversationRuntimeState(conversationRuntime);
      evictConversationRuntimeIfIdle(conversationRuntime);
    }

    if (runtime.intentionallyClosed) {
      opts.onDisconnected();
      return;
    }

    // 1008: Environment not found - need to re-register
    if (code === 1008) {
      if (isDebugEnabled()) {
        console.log("[Listen] Environment not found, re-registering...");
      }
      // Stop retry loop and signal that we need to re-register
      if (opts.onNeedsReregister) {
        opts.onNeedsReregister();
      } else {
        opts.onDisconnected();
      }
      return;
    }

    // If we had connected before, restart backoff from zero for this outage window.
    const nextAttempt = runtime.hasSuccessfulConnection ? 0 : attempt + 1;
    const nextStartTime = runtime.hasSuccessfulConnection
      ? Date.now()
      : startTime;
    runtime.hasSuccessfulConnection = false;

    connectWithRetry(runtime, opts, nextAttempt, nextStartTime).catch(
      (error) => {
        opts.onError(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

  socket.on("error", (error: Error) => {
    trackListenerError("listener_websocket_error", error, "listener_socket");
    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_error",
      message: error.message,
    });
    if (isDebugEnabled()) {
      console.error("[Listen] WebSocket error:", error);
    }
    // Error triggers close(), which handles retry logic.
  });
}

/**
 * Check if listener is currently active.
 */
export function isListenerActive(): boolean {
  const runtime = getActiveRuntime();
  return runtime !== null && runtime.transport !== null;
}

/**
 * Stop the active listener connection.
 */
export function stopListenerClient(): void {
  const runtime = getActiveRuntime();
  if (!runtime) {
    return;
  }
  setActiveRuntime(null);
  telemetry.setSurface(process.stdin.isTTY ? "tui" : "headless");
  stopRuntime(runtime, true);
}
