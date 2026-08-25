import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import WebSocket from "ws";
import { startScheduler as startCronScheduler } from "@/cron/scheduler";
import { createSharedReminderState } from "@/reminders/state";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import {
  getListenerTelemetrySurface,
  getTerminalTelemetrySurface,
  telemetry,
} from "@/telemetry";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import { loadTools } from "@/tools/manager";
import type { RuntimeScope } from "@/types/protocol_v2";
import { isDebugEnabled } from "@/utils/debug";
import { killAllTerminals } from "@/websocket/terminal-handler";
import {
  rejectPendingApprovalResolvers,
  rejectPendingApprovalResolversForConnection,
  replayPendingApprovalRequestsToConnection,
} from "./approval";
import { resolveListenerReconnectAuth } from "./auth";
import {
  getOrCreateProcessTransport,
  markListenerConnectionInitialized,
  openListenerConnection,
  suspendListenerConnection,
} from "./connection";
import {
  cleanupListenerConnection,
  closeListenerRuntimeConnections,
  createConnectionTurnProcessor,
} from "./connection-lifecycle";
import {
  emitInitialConnectionState,
  replaySubscribedConnectionState,
} from "./connection-state-sync";
import {
  INITIAL_RETRY_DELAY_MS,
  LISTENER_PONG_TIMEOUT_MS,
  MAX_RETRY_DELAY_MS,
  MAX_RETRY_DURATION_MS,
} from "./constants";
import {
  handleAbortMessageInput,
  handleApprovalResponseInput,
  handleChangeDeviceStateInput,
} from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { loadPersistedCwdMap } from "./cwd";
import {
  installExternalToolBridge,
  rejectPendingExternalToolCalls,
} from "./external-tools";
import { createFileCommandSession } from "./file-commands";
import { startConnectionHeartbeat } from "./heartbeat";
import { createListenerMessageHandler } from "./message-router";
import {
  disposeListenerModAdapter,
  reloadListenerModAdapter,
} from "./mod-adapter";
import { loadPersistedPermissionModeMap } from "./permission-mode";
import {
  clearProcessServices,
  installProcessEventRouting,
  invalidateProcessServices,
  waitForProcessServicesSlot,
} from "./process-services";
import { scheduleQueuePump } from "./queue";
import { recoverApprovalStateForSync } from "./recovery-sync";
import {
  clearConversationRuntimeState,
  clearRuntimeTimers,
  getActiveRuntime,
  safeEmitWsEvent,
  setActiveRuntime,
} from "./runtime";
import {
  applyListenerPairIdentity,
  attachSplitStreamSocketHandlers,
  createListenerPairIdentity,
  handleListenerSocketOpenFailure,
  isCurrentSocketPair,
  parseListenerReadyMessage,
  preparePairedListenerTransport,
  prepareSplitStreamTransport,
  shouldHandleControlSocketClose,
} from "./split-stream-lifecycle";
import { notifyStreamObserversRuntimeStopped } from "./stream-observers";
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
  LocalListenerTransport,
} from "./transport";
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
    if (isDebugEnabled())
      console.error(`[Listen] ${commandName} failed:`, error);
  });
}
export async function replaySyncStateForRuntime(
  listenerRuntime: ListenerRuntime,
  socket: WebSocket,
  scope: RuntimeScope<string | null>,
  opts?: {
    recoverApprovals?: boolean;
    recoverApprovalStateForSync?: (
      runtime: ConversationRuntime,
      scope: RuntimeScope<string | null>,
    ) => Promise<void>;
    scheduleWarmupsAfterSync?: (
      runtime: ListenerRuntime,
      scope: RuntimeScope<string | null>,
    ) => void;
    forceDeviceStatus?: boolean;
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

  replaySubscribedConnectionState(
    listenerRuntime,
    socket,
    syncScopedRuntime,
    scope,
    opts?.forceDeviceStatus,
  );
  (opts?.scheduleWarmupsAfterSync ?? scheduleListenerWarmupsAfterSync)(
    listenerRuntime,
    scope,
  );
}
function getParsedRuntimeScope(
  parsed: unknown,
): RuntimeScope<string | null> | null {
  if (!parsed || typeof parsed !== "object" || !("runtime" in parsed)) {
    return null;
  }

  const runtime = (
    parsed as {
      runtime?: { agent_id?: unknown; conversation_id?: unknown };
    }
  ).runtime;
  if (
    !runtime ||
    (runtime.agent_id !== null && typeof runtime.agent_id !== "string")
  )
    return null;

  return {
    agent_id: runtime.agent_id,
    conversation_id:
      typeof runtime.conversation_id === "string"
        ? runtime.conversation_id
        : "default",
  };
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

export function createRuntime(): ListenerRuntime {
  const bootWorkingDirectory = getCurrentWorkingDirectory();
  return {
    socket: null,
    transport: null,
    streamSocket: null,
    streamTransport: null,
    heartbeatInterval: null,
    reconnectTimeout: null,
    lastPongAt: null,
    intentionallyClosed: false,
    hasSuccessfulConnection: false,
    everConnected: false,
    sessionId: `listen-${crypto.randomUUID()}`,
    nextConnectionAttempt: 0,
    nextConnectionOrdinal: 0,
    connections: new Map(),
    connectionIdsByRuntimeKey: new Map(),
    processTransport: null,
    processServicesStarted: false,
    processServicesGeneration: 0,
    processServicesReady: null,
    processServicesReadyGeneration: null,
    serviceCommandHandler: null,
    serviceCommandTypes: new Set(),
    eventSeqCounter: 0,
    queueEmitScheduled: false,
    pendingQueueEmitScope: undefined,
    onWsEvent: undefined,
    reminderState: createSharedReminderState(),
    bootWorkingDirectory,
    workingDirectoryByConversation: loadPersistedCwdMap(),
    worktreeWatcherByConversation: new Map(),
    permissionModeByConversation: loadPersistedPermissionModeMap(),
    skillSourcesByConversation: new Map(),
    reminderStateByConversation: new Map(),
    contextTrackerByConversation: new Map(),
    systemPromptRecompileByConversation: new Map(),
    queuedSystemPromptRecompileByConversation: new Set(),
    connectionId: null,
    connectionName: null,
    conversationRuntimes: new Map(),
    memfsSyncedAgents: new Map(),
    secretsHydrationByAgent: new Map(),
    secretsHydrationFreshnessByAgent: new Map(),
    secretsDirtyAgents: new Set(),
    pendingExternalToolCalls: new Map(),
    agentMetadataByAgent: new Map(),
    lastEmittedStatus: null,
  };
}

export function stopRuntime(
  runtime: ListenerRuntime,
  suppressCallbacks: boolean,
): void {
  notifyStreamObserversRuntimeStopped(runtime);
  disposeListenerModAdapter(runtime);
  rejectPendingExternalToolCalls(runtime, "Listener runtime stopped");
  runtime.intentionallyClosed = true;
  invalidateProcessServices(runtime);
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
  closeListenerRuntimeConnections(runtime, suppressCallbacks);
  runtime.processServicesReady = null;
  runtime.processServicesReadyGeneration = null;
  clearListenerWarmState(runtime);
  runtime.reminderStateByConversation.clear();
  runtime.skillSourcesByConversation.clear();
  runtime.contextTrackerByConversation.clear();
  runtime.systemPromptRecompileByConversation.clear();
  runtime.queuedSystemPromptRecompileByConversation.clear();
  stopAllWorktreeWatchers(runtime);
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
    startProcessServices?: boolean;
    streamTransport?: ListenerTransport | null;
    emitInitialState?: boolean;
  } = {},
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) return;
  installExternalToolBridge(runtime);
  // LETTA_DISABLE_CRON_SCHEDULER=1 lets users opt out entirely. Useful when
  // running multiple letta-code instances against the same agent dir, since
  // only one process can hold the lease and the others would otherwise log
  // "scheduler lease held by PID ..." on every connect.
  const shouldStartCronScheduler =
    options.startCronScheduler !== false &&
    process.env.LETTA_DISABLE_CRON_SCHEDULER !== "1";

  markListenerConnectionInitialized(runtime, opts.connectionId);
  safeEmitWsEvent("recv", "lifecycle", {
    type:
      getListenerTransportKind(transport) === "websocket"
        ? "_ws_open"
        : "_local_open",
  });
  runtime.hasSuccessfulConnection = true;
  runtime.everConnected = true;
  await opts.onConnected(opts.connectionId);

  emitInitialConnectionState(runtime, transport, opts.connectionId, options);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    replayPendingApprovalRequestsToConnection(
      conversationRuntime,
      opts.connectionId,
    );
  }

  if (options.startHeartbeat !== false) {
    startConnectionHeartbeat(
      runtime,
      transport,
      () => {
        trackListenerError(
          "listener_pong_timeout",
          new Error(
            `No relay pong within ${LISTENER_PONG_TIMEOUT_MS}ms; terminating half-open socket to force reconnect`,
          ),
          "listener_heartbeat",
        );
        runtime.socket?.terminate();
      },
      (heartbeatTransport) => {
        return safeTransportSend(
          heartbeatTransport,
          { type: "ping" },
          "listener_ping_send_failed",
          "listener_heartbeat",
        );
      },
    );
  }

  if (options.startProcessServices === false) return;

  const processTransport = getOrCreateProcessTransport(runtime);
  for (const conversationRuntime of runtime.conversationRuntimes.values()) {
    if (conversationRuntime.queueRuntime?.isEmpty === false) {
      scheduleQueuePump(
        conversationRuntime,
        processTransport,
        opts as StartListenerOptions,
        processQueuedTurn,
      );
    }
  }

  if (runtime.processServicesStarted) return;
  if (!(await waitForProcessServicesSlot(runtime, opts.connectionId))) return;

  const processServicesGeneration = runtime.processServicesGeneration + 1;
  runtime.processServicesGeneration = processServicesGeneration;
  const processServicesReady = (async () => {
    const processTransport = getOrCreateProcessTransport(runtime);

    installProcessEventRouting({
      runtime,
      processTransport,
      opts: opts as StartListenerOptions,
      processQueuedTurn,
    });

    if (shouldStartCronScheduler) {
      startCronScheduler(
        processTransport,
        opts as StartListenerOptions,
        processQueuedTurn,
      );
    }

    if (runtime.processServicesGeneration === processServicesGeneration) {
      runtime.processServicesStarted = true;
    }
  })();
  runtime.processServicesReady = processServicesReady;
  runtime.processServicesReadyGeneration = processServicesGeneration;
  try {
    await processServicesReady;
  } catch (error) {
    if (runtime.processServicesGeneration !== processServicesGeneration) return;
    clearProcessServices(runtime);
    throw error;
  } finally {
    if (runtime.processServicesReady === processServicesReady) {
      runtime.processServicesReady = null;
      runtime.processServicesReadyGeneration = null;
    }
  }
}

/**
 * Attach an already-open, locally accepted websocket to a listener runtime.
 *
 * Unlike the cloud listener client path, this helper does not reconnect on
 * close. It is intended for local app-server transports where the HTTP server
 * keeps running and the next client connection creates a fresh runtime.
 */

export async function attachOpenListenerSocket(
  runtime: ListenerRuntime,
  socket: WebSocket,
  opts: StartListenerOptions,
  options: {
    streamSocket?: WebSocket | null;
    startHeartbeat?: boolean;
    startCronScheduler?: boolean;
    startProcessServices?: boolean;
    startupReady?: Promise<void>;
  } = {},
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    return;
  }

  const streamSocket = options.streamSocket ?? null;
  const connection = openListenerConnection({
    runtime,
    connectionId: opts.connectionId,
    writer: socket,
    streamWriter: streamSocket,
    options: opts,
  });
  const fileCommandSession = createFileCommandSession({
    socket,
    safeSocketSend,
    runDetachedListenerTask,
  });

  installExternalToolBridge(runtime);
  const transport: ListenerTransport = socket;
  const processQueuedTurn = createConnectionTurnProcessor(runtime);

  const handleMessage = createListenerMessageHandler({
    runtime,
    socket,
    connectionId: opts.connectionId,
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
  });
  socket.on("message", (data: WebSocket.RawData) => {
    void (async () => {
      await options.startupReady;
      if (
        connection.cancellation.signal.aborted ||
        runtime.connections.get(opts.connectionId) !== connection
      ) {
        return;
      }
      await handleMessage(data);
    })().catch((error) => {
      trackListenerError(
        "listener_message_handler_failed",
        error,
        "listener_message_handler",
      );
      opts.onError(error instanceof Error ? error : new Error(String(error)));
    });
  });

  socket.on("close", (code: number, reason: Buffer) => {
    if (
      runtime !== getActiveRuntime() ||
      runtime.connections.get(opts.connectionId) !== connection
    ) {
      return;
    }

    const reasonText = reason.toString();
    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_close",
      code,
      reason: reasonText,
    });
    fileCommandSession.dispose();
    cleanupListenerConnection(runtime, opts.connectionId);
    opts.onDisconnected();
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
  });

  if (streamSocket) {
    attachSplitStreamSocketHandlers({
      runtime,
      streamSocket,
      trackListenerError,
    });
  }

  await options.startupReady;
  if (
    connection.cancellation.signal.aborted ||
    runtime.connections.get(opts.connectionId) !== connection
  ) {
    return;
  }

  const streamTransport =
    streamSocket?.readyState === WebSocket.OPEN ? streamSocket : null;
  await startConnectedListenerRuntime(
    runtime,
    transport,
    opts,
    processQueuedTurn,
    {
      startHeartbeat: options.startHeartbeat ?? false,
      startCronScheduler: options.startCronScheduler ?? true,
      startProcessServices: options.startProcessServices ?? true,
      streamTransport,
      emitInitialState: false,
    },
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
  telemetry.setSurface(getListenerTelemetrySurface());
  telemetry.init();

  await reloadListenerModAdapter(runtime);
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
  telemetry.setSurface(getListenerTelemetrySurface());
  telemetry.init();

  try {
    await reloadListenerModAdapter(runtime);
    await loadTools();
    const transport = new LocalListenerTransport();
    const connectionOptions: StartListenerOptions = {
      ...opts,
      wsUrl: "local://listener",
      onDisconnected: () => {},
    };
    openListenerConnection({
      runtime,
      connectionId: opts.connectionId,
      writer: transport,
      options: connectionOptions,
    });
    const processQueuedTurn = createConnectionTurnProcessor(runtime);

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

/** Connect to WebSocket with exponential backoff retry. */
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

  const auth = await resolveListenerReconnectAuth(opts);
  if (auth.kind === "retry")
    return connectWithRetry(runtime, opts, attempt + 1, startTime);
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    return;
  }
  const apiKey = auth.apiKey;

  const url = new URL(opts.wsUrl);
  url.searchParams.set("deviceId", opts.deviceId);
  url.searchParams.set("connectionName", opts.connectionName);

  const supportsSplitStatusChannels = opts.supportsSplitStatusChannels === true;
  const pairIdentity =
    supportsSplitStatusChannels &&
    opts.supportsPairedListenerGenerations === true
      ? createListenerPairIdentity(runtime)
      : null;
  if (supportsSplitStatusChannels) url.searchParams.set("channel", "control");
  if (pairIdentity) applyListenerPairIdentity(url, pairIdentity);

  const streamUrl = supportsSplitStatusChannels ? new URL(url) : null;
  if (streamUrl) streamUrl.searchParams.set("channel", "stream");
  const headers = { Authorization: `Bearer ${apiKey}` };
  const socket = new WebSocket(url.toString(), { headers });
  let streamSocket =
    streamUrl && !pairIdentity
      ? new WebSocket(streamUrl.toString(), { headers })
      : null;

  const fileCommandSession = createFileCommandSession({
    socket,
    safeSocketSend,
    runDetachedListenerTask,
  });

  runtime.socket = socket;
  runtime.streamSocket = streamSocket;
  const transport = socket;
  const processQueuedTurn = createConnectionTurnProcessor(runtime);
  const handleMessage = createListenerMessageHandler({
    runtime,
    socket,
    connectionId: opts.connectionId,
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
  });
  let pairedStartupReady = pairIdentity === null;
  const pendingStartupFrames: WebSocket.RawData[] = [];
  if (streamSocket) {
    attachSplitStreamSocketHandlers({
      runtime,
      streamSocket,
      trackListenerError,
    });
  }

  socket.on("open", () => {
    void (async () => {
      const streamOpen = pairIdentity
        ? await preparePairedListenerTransport({
            runtime,
            controlSocket: socket,
            identity: pairIdentity,
            createStreamSocket: () => {
              if (!streamUrl) throw new Error("Paired stream URL is missing");
              streamSocket = new WebSocket(streamUrl.toString(), { headers });
              return streamSocket;
            },
            trackListenerError,
          })
        : await prepareSplitStreamTransport({
            runtime,
            controlSocket: socket,
            streamSocket,
            trackListenerError,
          });
      if (streamOpen.kind !== "ready") return;
      const streamTransport = streamOpen.transport;
      if (streamOpen.streamSocket) {
        streamSocket = streamOpen.streamSocket;
        attachSplitStreamSocketHandlers({
          runtime,
          streamSocket: streamOpen.streamSocket,
          trackListenerError,
        });
      }
      if (!isCurrentSocketPair(runtime, socket, streamSocket)) return;
      openListenerConnection({
        runtime,
        connectionId: opts.connectionId,
        writer: socket,
        streamWriter: streamTransport,
        options: opts,
      });
      await startConnectedListenerRuntime(
        runtime,
        transport,
        opts,
        processQueuedTurn,
        {
          startHeartbeat: true,
          startCronScheduler: true,
          streamTransport,
        },
      );
      pairedStartupReady = true;
      for (const frame of pendingStartupFrames.splice(0)) {
        await handleMessage(frame);
      }
    })().catch((error) => {
      handleListenerSocketOpenFailure({
        runtime,
        controlSocket: socket,
        streamSocket,
        error,
        trackListenerError,
      });
    });
  });

  socket.on("message", (data: WebSocket.RawData) => {
    if (
      pairIdentity &&
      !pairedStartupReady &&
      !parseListenerReadyMessage(data)
    ) {
      pendingStartupFrames.push(data);
      return;
    }
    void handleMessage(data);
  });

  socket.on("close", (code: number, reason: Buffer) => {
    if (!shouldHandleControlSocketClose(runtime, socket, opts.connectionId)) {
      return;
    }

    safeEmitWsEvent("recv", "lifecycle", {
      type: "_ws_close",
      code,
      reason: reason.toString(),
    });

    fileCommandSession.dispose();
    const reasonText = reason.toString();
    const terminalClose =
      runtime.intentionallyClosed ||
      code === 1008 ||
      (code === 1000 && reasonText === "Replaced by new connection");

    clearRuntimeTimers(runtime);

    if (isDebugEnabled()) {
      console.log(
        `[Listen] WebSocket disconnected (code: ${code}, reason: ${reason.toString()})`,
      );
    }

    if (!terminalClose) {
      for (const conversationRuntime of runtime.conversationRuntimes.values()) {
        rejectPendingApprovalResolversForConnection(
          conversationRuntime,
          opts.connectionId,
          "Listener connection closed",
        );
      }
    }
    suspendListenerConnection(runtime, opts.connectionId);
    killAllTerminals();
    clearListenerWarmState(runtime);
    if (streamSocket) {
      streamSocket.removeAllListeners("message");
      streamSocket.removeAllListeners("open");
      streamSocket.removeAllListeners("close");
      if (
        streamSocket.readyState === WebSocket.OPEN ||
        streamSocket.readyState === WebSocket.CONNECTING
      ) {
        streamSocket.close();
      }
    }
    runtime.socket = null;
    runtime.streamSocket = null;
    runtime.streamTransport = null;
    if (terminalClose) {
      if (getActiveRuntime() === runtime) {
        setActiveRuntime(null);
      }
      stopRuntime(runtime, true);

      if (code === 1008) {
        if (isDebugEnabled()) {
          console.log("[Listen] Environment not found, re-registering...");
        }
        if (opts.onNeedsReregister) {
          opts.onNeedsReregister();
        } else {
          opts.onDisconnected();
        }
        return;
      }

      opts.onDisconnected();
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
  telemetry.setSurface(getTerminalTelemetrySurface(!process.stdin.isTTY));
  stopRuntime(runtime, true);
}
