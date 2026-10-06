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
import { isDebugEnabled } from "@/utils/debug";
import { sealStartupLogs } from "@/utils/startup-log-boundary";
import { killAllTerminals } from "@/websocket/terminal-handler";
import {
  rejectPendingApprovalResolvers,
  rejectPendingApprovalResolversForConnection,
} from "./approval";
import { resolveListenerReconnectAuth } from "./auth";
import {
  getOrCreateProcessTransport,
  isCurrentInitializedListenerConnection,
  openListenerConnection,
  suspendListenerConnection,
} from "./connection";
import {
  cleanupListenerConnection,
  closeListenerRuntimeConnections,
  createConnectionTurnProcessor,
} from "./connection-lifecycle";
import { completeInitialConnectionStartup } from "./connection-state-sync";
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  MAX_RETRY_DURATION_MS,
} from "./constants";
import {
  handleAbortMessageInput,
  handleApprovalResponseInput,
  handleChangeDeviceStateInput,
} from "./control-inputs";
import {
  getOrCreateScopedRuntime,
  promotePreparedInputTerminals,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import { loadPersistedCwdMap } from "./cwd";
import {
  createExternalToolNotificationState,
  installExternalToolBridge,
  rejectPendingExternalToolCalls,
} from "./external-tools";
import { createFileCommandSession } from "./file-commands";
import { startListenerPongHeartbeat } from "./heartbeat";
import {
  getParsedRuntimeScope,
  stampInboundUserMessageOtids,
} from "./inbound-runtime-scope";
import { createAcceptedInputDispositionLedger } from "./input-disposition";
import {
  adoptListenerClientReplacement,
  assertAdoptableListenerClientReplacement,
  createListenerClientReplacement,
} from "./listener-replacement";
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
import {
  type recoverRecordedTurns,
  scheduleRecordedTurnRecovery,
} from "./recover-recorded-turn";
import { revokeRecoveryClaims } from "./recovery-ownership";
import {
  clearConversationRuntimeState,
  clearRuntimeTimers,
  getActiveRuntime,
  safeEmitWsEvent,
  setActiveRuntime,
} from "./runtime";
import { safeSocketSend } from "./socket-send";
import {
  applyListenerPairIdentity,
  attachSplitStreamSocketHandlers,
  createListenerPairIdentity,
  handleListenerSocketOpenFailure,
  isCurrentSocketPair,
  preparePairedListenerTransport,
  prepareSplitStreamTransport,
  shouldHandleControlSocketClose,
} from "./split-stream-lifecycle";
import { StartupFrameBuffer } from "./startup-frame-buffer";
import {
  activateStartupIngress,
  claimRequestlessStartupFrameHandoff,
  createReportedIngressHandler,
  handoffRequestlessStartupFrames,
  poisonCurrentStartupIngressOwner,
  reserveStartupIngressOwner,
  waitForStartupOrAbort,
} from "./startup-ingress";
import { notifyStreamObserversRuntimeStopped } from "./stream-observers";
import { replaySyncStateForRuntime } from "./sync-replay";
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
  LocalListenerTransport,
} from "./transport";
import type {
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";
import { clearListenerWarmState } from "./warmup";
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
    ...createExternalToolNotificationState(),
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
    connectionGeneration: null,
    connectionName: null,
    conversationRuntimes: new Map(),
    acceptedInputDispositionLedger: createAcceptedInputDispositionLedger(),
    activeRecoveryClaims: new Set(),
    pendingStartupFramesByLineage: new Map(),
    startupGenerationByLineage: new Map(),
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
  revokeRecoveryClaims(runtime);
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
    | "connectionId"
    | "onConnected"
    | "onConnectionReady"
    | "onStatusChange"
    | "onWsEvent"
  >,
  processQueuedTurn: ProcessQueuedTurn,
  options: {
    startHeartbeat?: boolean;
    startCronScheduler?: boolean;
    startProcessServices?: boolean;
    streamTransport?: ListenerTransport | null;
    emitInitialState?: boolean;
    updateReconnectState?: boolean;
    recoverRecordedWork?: typeof recoverRecordedTurns;
    activateIngress?: () => Promise<boolean>;
  } = {},
): Promise<void> {
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) return;
  const startupConnection = runtime.connections.get(opts.connectionId);
  if (!startupConnection || startupConnection.writer !== transport) return;
  sealStartupLogs();
  installExternalToolBridge(runtime);
  // Opt out when another process already holds the cron scheduler lease.
  // LETTA_DISABLE_CRON_SCHEDULER=1 suppresses recurring lease-held messages.
  const shouldStartCronScheduler =
    options.startCronScheduler !== false &&
    process.env.LETTA_DISABLE_CRON_SCHEDULER !== "1";

  safeEmitWsEvent("recv", "lifecycle", {
    type:
      getListenerTransportKind(transport) === "websocket"
        ? "_ws_open"
        : "_local_open",
  });
  // Terminal intent and input replay are one journaled transition. Promote it
  // before state sync so this very connection can replay the terminal instead
  // of waiting for another reconnect.
  promotePreparedInputTerminals(runtime);
  if (
    !(await completeInitialConnectionStartup(
      runtime,
      startupConnection,
      transport,
      opts,
      options,
    ))
  )
    return;
  const isExactOpenConnection = (): boolean =>
    runtime === getActiveRuntime() &&
    runtime.connections.get(startupConnection.id) === startupConnection &&
    !startupConnection.cancellation.signal.aborted &&
    isListenerTransportOpen(startupConnection.writer);
  if (options.activateIngress && !(await options.activateIngress())) return;
  if (!isExactOpenConnection()) return;
  startupConnection.ingressReady = true;
  await opts.onConnectionReady?.(startupConnection);
  if (!isExactOpenConnection() || !startupConnection.ingressReady) return;
  if (options.startHeartbeat !== false) {
    startListenerPongHeartbeat(runtime, transport, trackListenerError);
  }

  if (options.startProcessServices === false) return;
  // Managed remote listeners adopt an open gateway and resume local records.
  runtime.scheduleRecordedRecovery = () =>
    scheduleRecordedTurnRecovery(runtime, options.recoverRecordedWork);
  scheduleRecordedTurnRecovery(runtime, options.recoverRecordedWork);

  // This must precede the existing startup pump loop: a queued acknowledgement
  // is final to Cloud, so only the durable local payload can recreate the work.
  restoreDurableQueuedInputs(runtime);
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
  if (runtime.connections.get(opts.connectionId) !== startupConnection) return;
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
  const handleIngressMessage = createReportedIngressHandler(
    handleMessage,
    trackListenerError,
    opts.onError,
  );
  const pendingStartupFrames = StartupFrameBuffer.forSockets(
    socket,
    () => streamSocket,
    trackListenerError,
    (capacity) =>
      poisonCurrentStartupIngressOwner(
        runtime,
        connection.startupOwner,
        capacity,
      ),
  );
  const abortStartupIngress = (): void => {
    handoffRequestlessStartupFrames(
      runtime,
      connection.startupOwner,
      pendingStartupFrames,
    );
    pendingStartupFrames.abort();
  };
  connection.cancellation.signal.addEventListener(
    "abort",
    abortStartupIngress,
    { once: true },
  );
  socket.on("message", (data: WebSocket.RawData) => {
    pendingStartupFrames.accept(data, handleIngressMessage);
  });

  socket.on("close", (code: number, reason: Buffer) => {
    if (
      runtime !== getActiveRuntime() ||
      runtime.connections.get(opts.connectionId) !== connection
    ) {
      return;
    }

    const reasonText = reason.toString();
    abortStartupIngress();
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

  await waitForStartupOrAbort(
    options.startupReady,
    connection.cancellation.signal,
  );
  if (
    connection.cancellation.signal.aborted ||
    runtime.connections.get(opts.connectionId) !== connection
  ) {
    abortStartupIngress();
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
      activateIngress: activateStartupIngress(
        pendingStartupFrames,
        handleIngressMessage,
        () =>
          Boolean(
            runtime === getActiveRuntime() &&
              runtime.connections.get(opts.connectionId) === connection &&
              !connection.cancellation.signal.aborted &&
              isListenerTransportOpen(connection.writer),
          ),
        () =>
          claimRequestlessStartupFrameHandoff(runtime, connection.startupOwner),
      ),
    },
  );
}

/**
 * Start the listener WebSocket client with automatic retry.
 */
export async function startListenerClient(
  opts: StartListenerOptions,
): Promise<void> {
  // Prove the replacement token belongs to the exact authoritative predecessor
  // before anything is torn down. A stale or replayed token must fail here,
  // while the runtime it claims to replace is still intact.
  assertAdoptableListenerClientReplacement(opts);

  // Replace any existing runtime without stale callback leakage.
  const existingRuntime = getActiveRuntime();
  if (existingRuntime) {
    stopRuntime(existingRuntime, true);
  }

  const runtime = createRuntime();
  adoptListenerClientReplacement(runtime, opts);
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
  onConnected: (connectionId: string) => void | Promise<void>;
  onConnectionReady?: StartListenerOptions["onConnectionReady"];
  onError: (error: Error) => void;
  onStatusChange?: StartListenerOptions["onStatusChange"];
  onLog?: StartListenerOptions["onLog"];
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
        opts.onNeedsReregister(createListenerClientReplacement(runtime, opts));
        return;
      }
      opts.onError(new Error("Failed to connect after 5 minutes of retrying"));
      return;
    }

    const delay = Math.min(
      INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
    opts.onRetrying?.(attempt, MAX_RETRY_ATTEMPTS, delay, opts.connectionId);

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
  // Ingress is buffered from the moment the control socket opens, which is
  // before the stream channel is prepared and therefore before a connection
  // can be opened. Claim the lineage up front so requestless frames buffered
  // in that window are handed to the successor exactly once instead of being
  // dropped when the attempt dies with no connection to attribute them to.
  const startupOwner = reserveStartupIngressOwner(runtime, opts);
  const pendingStartupFrames = StartupFrameBuffer.forSockets(
    socket,
    () => streamSocket,
    trackListenerError,
    (capacity) =>
      poisonCurrentStartupIngressOwner(runtime, startupOwner, capacity),
  );
  const abortStartupIngress = (): void => {
    handoffRequestlessStartupFrames(
      runtime,
      startupOwner,
      pendingStartupFrames,
    );
    pendingStartupFrames.abort();
  };
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
      runtime.connectionGeneration = pairIdentity?.connectionGeneration ?? null;
      const connection = openListenerConnection({
        runtime,
        connectionId: opts.connectionId,
        writer: socket,
        streamWriter: streamTransport,
        options: opts,
        startupOwner,
      });
      await startConnectedListenerRuntime(
        runtime,
        transport,
        opts,
        processQueuedTurn,
        {
          startHeartbeat: true,
          startCronScheduler: true,
          updateReconnectState: true,
          streamTransport,
          activateIngress: activateStartupIngress(
            pendingStartupFrames,
            handleMessage,
            () =>
              Boolean(
                isCurrentSocketPair(runtime, socket, streamSocket) &&
                  runtime.connections.get(connection.id) === connection &&
                  !connection.cancellation.signal.aborted &&
                  isListenerTransportOpen(connection.writer),
              ),
            () => claimRequestlessStartupFrameHandoff(runtime, startupOwner),
          ),
        },
      );
      if (!isCurrentInitializedListenerConnection(runtime, connection)) return;
    })().catch((error) => {
      abortStartupIngress();
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
    pendingStartupFrames.accept(data, handleMessage);
  });

  socket.on("close", (code: number, reason: Buffer) => {
    abortStartupIngress();
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

    if (!terminalClose && runtime.hasSuccessfulConnection) {
      opts.onRetrying?.(0, MAX_RETRY_ATTEMPTS, 0, opts.connectionId);
    }

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
      const replacement =
        code === 1008 ? createListenerClientReplacement(runtime, opts) : null;
      if (getActiveRuntime() === runtime) {
        setActiveRuntime(null);
      }
      stopRuntime(runtime, true);

      if (code === 1008) {
        if (isDebugEnabled()) {
          console.log("[Listen] Environment not found, re-registering...");
        }
        if (opts.onNeedsReregister) {
          if (!replacement) {
            throw new Error("Missing listener replacement lineage");
          }
          opts.onNeedsReregister(replacement);
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
