import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import type {
  ApprovalDecision,
  ApprovalResult,
} from "@/agent/approval-execution";
import type { AttributedMessageCreate } from "@/agent/message-attribution";
import type { SkillSource } from "@/agent/skill-sources";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ModAdapter } from "@/mods/mod-adapter";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
  QueueRuntime,
} from "@/queue/queue-runtime";
import type { SharedReminderState } from "@/reminders/state";
import type { RuntimeWorkspaceSandbox } from "@/runtime-context";
import type { RuntimeExecutionSettings } from "@/runtime-execution-settings";
import type { ToolsetName, ToolsetPreference } from "@/tools/toolset";
import type { UsageStatistics } from "@/types/protocol";
import type {
  ApprovalResponseBody,
  AvailableSkillSummary,
  ClientToolsetConfig,
  ControlRequest,
  ExternalToolCallResult,
  LoopStatus,
  RuntimeScope,
  StopReasonType,
  TeleportContinuation,
  WsProtocolCommand,
} from "@/types/protocol_v2";
import type {
  ServiceCommandRequest,
  ServiceCommandResponse,
} from "@/types/service-protocol";
import type { ListenerTransport } from "./transport";
import type { TurnLifecycle } from "./turn-lifecycle";

export interface StartListenerOptions {
  connectionId: string;
  wsUrl: string;
  supportsSplitStatusChannels?: boolean;
  supportsPairedListenerGenerations?: boolean;
  deviceId: string;
  connectionName: string;
  /** False when reconnecting necessarily allocates a new physical id. */
  connectionIdCanResume?: boolean;
  skillsDirectory?: string;
  onConnected: (connectionId: string) => void | Promise<void>;
  /** Called only after initial state and approvals are replayed and the exact connection is routable. */
  onConnectionReady?: (
    connection: ListenerConnectionState,
  ) => void | Promise<void>;
  onDisconnected: () => void;
  onNeedsReregister?: (replacement: ListenerClientReplacement) => void;
  /** Explicit state lineage supplied only by onNeedsReregister. */
  replacement?: ListenerClientReplacement;
  onError: (error: Error) => void;
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void;
  onLog?: (message: string) => void;
  onRetrying?: (
    attempt: number,
    maxAttempts: number,
    nextRetryIn: number,
    connectionId: string,
  ) => void;
  onWsEvent?: (
    direction: "send" | "recv",
    label: "client" | "protocol" | "control" | "lifecycle",
    event: unknown,
  ) => void;
}

/** Options a `sync` command carries into the listener's state replay. */
export type SyncReplayOptions = {
  /** `SyncCommand.recover_approvals`: consult the backend for stale approvals. */
  recoverApprovals?: boolean;
  /** `SyncCommand.resume_interrupted_turn`: owner-only immediate continuation. */
  resumeInterruptedTurn?: boolean;
  forceDeviceStatus?: boolean;
  onStatusChange?: StartListenerOptions["onStatusChange"];
  connectionId?: string;
};

export interface IncomingMessage {
  type: "message";
  /**
   * Transport connection that delivered this message. Queueing carries this
   * identity through to the turn so approvals and other interactive requests
   * return to the correct client even when multiple clients share a runtime.
   */
  connectionId?: ListenerConnectionId;
  agentId?: string | null;
  conversationId?: string;
  /** Queue this message as its own turn; never merge with other messages. */
  noCoalesce?: boolean;
  /**
   * This turn's output is owned by an in-process caller (the OpenAI-compatible
   * HTTP bridge), not by a relay WebSocket client. Such turns are consumed by
   * in-process stream observers and returned in the HTTP response, so they must
   * not block on a listener connection that may never attach.
   *
   * Ownership varies per turn, not per runtime: one app-server runtime serves
   * both HTTP requests and real WebSocket clients, and relay-originated turns
   * still need the reconnect wait that preserves their output.
   */
  processOwnedTurn?: boolean;
  imageFailureMode?: "strict" | "drop";
  clientToolAllowlist?: string[];
  clientToolset?: ClientToolsetConfig;
  clientPreferences?: import("@/types/client-preferences").ClientPreferences;
  externalToolScopeIds?: string[];
  /** Exclude interactive user-input tools (AskUserQuestion) from this turn's toolset. */
  excludeInteractiveTools?: boolean;
  responseFormat?: Record<string, unknown>;
  messages: Array<
    (AttributedMessageCreate & { client_message_id?: string }) | ApprovalCreate
  >;
  /**
   * Cloud user id of the human who actually pressed "send", forwarded
   * from cloud-api's status WS. When set, the listener echoes it on
   * the outbound createMessage HTTP call (X-Letta-Acting-User-Id) so
   * cloud attributes credits + rate limits to the actual sender, not
   * to whoever spawned the sandbox / desktop runtime. Undefined for
   * self-hosted, single-user, or pre-channel-split flows.
   */
  actingUserId?: string;
  /**
   * Internal recovery sentinel: this input is explicitly unattributed, so the
   * outbound request must not inherit an actor from runtime context or env.
   */
  suppressActingUserFallback?: boolean;
  /** Exact durable-ledger identities owned by this admitted/dequeued turn. */
  durableInputIdentities?: readonly InputIdentity[];
  /** External applications which must acknowledge this turn's terminal. */
  terminalConsumerIds?: readonly string[];
}

export type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

/**
 * An outbound v2 protocol message as delivered to in-process stream
 * observers: the pre-envelope message payload plus its resolved runtime
 * scope (agent/conversation) and optional subagent attribution.
 */
export interface ObservedProtocolV2Message {
  type: string;
  runtime: { agent_id?: string | null; conversation_id?: string | null };
  subagent_id?: string;
  [key: string]: unknown;
}

export type ListenerStreamObserver = (
  message: ObservedProtocolV2Message,
) => void;

export interface PendingExternalToolCall {
  connectionId: ListenerConnectionId;
  resolve: (result: ExternalToolCallResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export type PendingTeleport = {
  teleportId: string;
  connectionId: ListenerConnectionId;
  agentId: string;
  conversationId: string;
  requestedAt: number;
  drainAcceptedInputs: boolean;
  activeTurn: boolean;
  readyAt?: number;
  error?: string;
  continuation?: TeleportContinuation;
  /** Exact interrupted-turn predecessor admitted by a failed teleport payload. */
  interruptedRevision?: string;
};

export interface ModeChangePayload {
  mode: "standard" | "acceptEdits" | "unrestricted" | "strict";
}

export interface ChangeCwdMessage {
  agentId?: string | null;
  conversationId?: string | null;
  cwd: string;
}

export type InboundMessagePayload =
  | (MessageCreate & { client_message_id?: string })
  | ApprovalCreate;

export type ServerMessage = WsProtocolCommand;

export type InvalidInputCommand = {
  type: "__invalid_input";
  runtime: RuntimeScope;
  reason: string;
};

export type ParsedServerMessage = ServerMessage | InvalidInputCommand;

export type PendingApprovalResolver = {
  requestId: string;
  connectionIds: Set<ListenerConnectionId>;
  resolve: (response: ApprovalResponseBody) => void;
  reject: (reason: Error) => void;
  controlRequest?: ControlRequest;
};

export type RecoveredApprovalState = {
  agentId: string;
  conversationId: string;
  /** Durable actor associated with the interrupted request, when attributed. */
  actingUserId?: string;
  autoDecisions?: ApprovalDecision[];
  allApprovals?: ApprovalRequest[];
  durableInputIdentities?: readonly InputIdentity[];
  terminalConsumerIds?: readonly string[];
  /** Interrupted-record revision this recovery authority originally observed. */
  interruptedRevision?: string;
  /** Existing durable lineage reused when restart observes an in-flight recovery. */
  recoveryLineageId?: string;
  /** Mutable sidecar generation fencing continuation checkpoints and terminal. */
  recoveryRevisionToken?: string;
  /** The lineage lives beside an independent successor's main revision. */
  recoveryUsesIndependentSuccessor?: boolean;
};

export type AcceptedInputDisposition = "started" | "queued";

/**
 * Identity domains that share the accepted-input ledger.
 *
 * `input` holds client-chosen `client_message_id`s and `teleport` holds
 * cloud-chosen teleport ids. They are separate key spaces: a client that sends
 * `client_message_id: "teleport:<id>"` must never collide with, suppress, or
 * be suppressed by a teleport continuation carrying that same id.
 */
export type InputIdentityDomain = "input" | "teleport";

export type InputIdentity = {
  readonly domain: InputIdentityDomain;
  readonly id: string;
};

export type DurableQueuedInput = {
  scope: {
    agentId: string | null;
    conversationId: string;
  };
  /** Exact ledger namespace/id; never inferred from message-shaped payload data. */
  identity: InputIdentity;
  /** Complete create-message execution context, including client preferences. */
  incoming: IncomingMessage;
  /** Sender attribution forwarded separately from the protocol payload. */
  actingUserId?: string;
};

/** Terminal intent committed in the same durable transaction that retires input replay. */
export type DurablePreparedInputTerminal = {
  /** Wall-clock diagnostic; authority ordering uses preparationSequence. */
  preparedAt?: number;
  /** Durable monotonic order used to reconcile legacy retired authority. */
  preparationSequence?: number;
  /** Durable claim that orders this publication before later quarantine. */
  publicationClaimed?: true;
  scope: { agentId: string | null; conversationId: string };
  message: {
    type: "turn_finished";
    turn_id: string;
    stop_reason: StopReasonType;
    terminal_consumer_ids?: string[];
    run_id?: string;
    error?: string;
    usage?: UsageStatistics;
  };
  owner: {
    connectionId: string | null;
    canRotate: boolean;
    lineageId: string | null;
    /** Stable identity for this exact terminal operation across journal promotion. */
    terminalIdentity?: string;
    /** Exact interrupted-work revision this terminal supersedes. */
    interruptedRevision?: string;
    /** Independent recovery lineage whose mutable authority was observed. */
    recoveryLineageId?: string;
    /** Exact mutable main/sidecar generation validated by this terminal. */
    interruptedAuthorityRevision?: string;
    preparationSequence?: number;
  };
};

export type InterruptedTerminalAuthority = {
  interruptedRevision: string;
  authorityRevision: string;
  recoveryLineageId?: string;
  terminalIdentity?: string;
  preparationSequence?: number;
  publicationClaimed?: true;
};

export type AcceptedInputDispositionEntry = {
  disposition: AcceptedInputDisposition | null;
  acceptedAt: number;
  expiresAt: number;
  runtimeKey: string;
  generation: number;
  /** Present while accepted work must be replayed after a process crash. */
  queuedInput?: DurableQueuedInput;
  /** Durable terminal/successor marker set atomically when replay data is retired. */
  replayCompleted?: true;
  /** Pending promotion into the terminal replay store after an atomic effect commit. */
  preparedTerminal?: DurablePreparedInputTerminal;
  /** Compact predecessor migration fence for an authority that cannot be replayed. */
  legacyAuthorityQuarantine?: {
    scope: { agentId: string | null; conversationId: string };
    recoveryLineageId: string;
    interruptedRevision: string;
    expiresAt: number;
  };
  /** Interrupted-work revision already superseded by a durable terminal. */
  completedTerminalRevision?: string;
  /** Exact main/sidecar generation superseded by the durable terminal. */
  completedTerminalAuthority?: InterruptedTerminalAuthority;
};

export type ActiveRecoveryClaim = {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly owned: boolean;
  release(): Promise<void>;
  /** Synchronously fence local ownership, then release the Cloud token best-effort. */
  revoke(): void;
  abandon(): void;
};

export type AcceptedInputDispositionLedger = {
  entries: Map<string, AcceptedInputDispositionEntry>;
  scopeCounts: Map<string, number>;
  /** Bounded predecessor migration fences excluded from admission capacity. */
  quarantinedCount: number;
  expiryQueue: Array<{ key: string; expiresAt: number; generation: number }>;
  expiryQueueHead: number;
  nextGeneration: number;
  /** Reservations whose durable rollback failed and may be reclaimed exactly. */
  abandonedReservations: Map<
    string,
    { generation: number; token: string | undefined }
  >;
  /** Durable cross-process store; null is used by isolated unit runtimes. */
  persistentPath: string | null;
};

export type InputDispositionReservation = {
  key: string;
  generation: number;
  runtimeKey: string;
  /** Unforgeable owner for a filesystem reservation. */
  token?: string;
  ownerPid?: number;
  ownerProcessStart?: string | null;
};

/**
 * Explicit owner of one startup ingress buffer.
 *
 * Reserved before the transport that will carry it exists, so pre-ready
 * requestless frames always have an exact lineage to be handed to even when a
 * connection attempt dies before any `ListenerConnectionState` is opened.
 */
export type StartupIngressOwner = {
  readonly lineageId: string;
  readonly generation: number;
  /** False for connections that cannot prove an exact replacement identity. */
  readonly handoffEnabled: boolean;
};

export type StartupFrameCapacity = "frame_count" | "byte_count";

/**
 * Bounded startup payload, or a bounded poison marker when the lineage exceeded
 * ingress capacity. The marker must survive every replacement hop so a later
 * connection cannot mistake discarded requestless input for an empty handoff.
 */
export type StartupFrameHandoff =
  | {
      readonly kind: "frames";
      readonly frames: WebSocket.RawData[];
      readonly byteLength: number;
    }
  | {
      readonly kind: "overflow";
      readonly capacity: StartupFrameCapacity;
    };

/**
 * Opaque, one-shot ownership transfer across Cloud re-registration.
 *
 * Only routing metadata is public. All mutable successor state is retained in
 * private provenance keyed by this token, so possession never grants mutation
 * authority over the handoff before or after adoption.
 */
export type ListenerClientReplacement = Readonly<{
  deviceId: string;
  connectionName: string;
  lineageId: string;
  generation: number;
}>;

export type ConversationRuntime = {
  listener: ListenerRuntime;
  key: string;
  agentId: string | null;
  conversationId: string;
  /** Runtime-scoped SDK override. Undefined uses the process defaults. */
  skillSources: SkillSource[] | undefined;
  /** Explicit runtime filesystem boundary for shared app-server sessions. */
  workspaceSandbox: RuntimeWorkspaceSandbox | undefined;
  executionSettings?: RuntimeExecutionSettings;
  /** Connection currently executing this conversation's turn, if client-owned. */
  activeConnectionId: ListenerConnectionId | null;
  turnLifecycle: TurnLifecycle;
  messageQueue: Promise<void>;
  pendingApprovalResolvers: Map<string, PendingApprovalResolver>;
  recoveredApprovalState: RecoveredApprovalState | null;
  /**
   * Teleport whose `teleport_continue` this scope is waiting for, set by the
   * cloud's destination `runtime_start`. While it is set (and not expired),
   * sync recovery leaves the source's pending approvals to the continuation.
   */
  expectedTeleportId: string | null;
  expectedTeleportExpiresAt: number | null;
  readonly lastStopReason: StopReasonType | null;
  lastTerminalLoopErrorMessage: string | null;
  lastTerminalLoopErrorRunId: string | null;
  readonly isProcessing: boolean;
  readonly activeWorkingDirectory: string | null;
  expectedWorktreePath: string | null;
  expectedWorktreeExpiresAt: number | null;
  readonly activeRunId: string | null;
  readonly cancelRequested: boolean;
  queueRuntime: QueueRuntime;
  queuedMessagesByItemId: Map<string, IncomingMessage>;
  /** Exact send identities carried by each batch removed from the queue. */
  dequeuedClientMessageIdsByBatchId: Map<string, string[]>;
  /** Durable ledger identities carried by each batch removed from the queue. */
  dequeuedInputIdentitiesByBatchId: Map<string, InputIdentity[]>;
  queuePumpActive: boolean;
  queuePumpScheduled: boolean;
  /**
   * Inbound messages chained on messageQueue that captured this runtime but
   * have not settled. Blocks idle eviction so they never run detached.
   */
  pendingInboundDispatches: number;
  pendingTurns: number;
  readonly loopStatus: LoopStatus;
  currentToolset: ToolsetName | null;
  currentToolsetPreference: ToolsetPreference;
  currentLoadedTools: string[];
  currentAvailableSkills: AvailableSkillSummary[];
  transientChannelRuntimeTools: boolean;
  pendingApprovalBatchByToolCallId: Map<string, string>;
  /**
   * tool_call_id -> server-assigned id of the approval_request_message that
   * carried the tool call. client_tool_start/end reuse this id instead of
   * minting a phantom `message-*` id (LET-10608). Populated and cleared
   * alongside pendingApprovalBatchByToolCallId.
   */
  approvalMessageIdByToolCallId: Map<string, string>;
  pendingInterruptedResults: Array<ApprovalResult> | null;
  pendingInterruptedContext: {
    agentId: string | null;
    conversationId: string;
    continuationEpoch: number;
    requestOtid?: string;
  } | null;
  continuationEpoch: number;
  pendingInterruptedToolCallIds: string[] | null;
  /** Terminal delivery waits that may transfer to a rotating replacement. */
  pendingTerminalDeliveryCount: number;
  /** Per-conversation reminder state (session-context, agent-info, etc.). */
  reminderState: SharedReminderState;
  /** Per-conversation tracker for compaction/reflection cadence. */
  contextTracker: ContextTracker;
};

export type ListenerConnectionId = string;

/**
 * Explicit destination for one outbound listener message.
 *
 * This mirrors Codex's OutgoingEnvelope split. Scoped notifications never
 * fall back to every connected client: ToSubscribers with an empty subscriber
 * set is intentionally a no-op.
 */
export type ListenerMessageRouting =
  | {
      type: "ToConnection";
      connectionId: ListenerConnectionId;
    }
  | {
      type: "ToSubscribers";
    }
  | {
      type: "Broadcast";
    };

/**
 * State owned by one transport connection.
 *
 * This mirrors Codex's ConnectionState: the process runtime owns services and
 * conversations, while each client owns its writer, cancellation handle,
 * initialization state, subscriptions, request resources, and event sequence.
 */
export type ListenerConnectionState = {
  id: ListenerConnectionId;
  ordinal: number;
  /** Explicit replacement lineage; unrelated concurrent connections differ. */
  startupOwner: StartupIngressOwner;
  writer: ListenerTransport;
  streamWriter: ListenerTransport | null;
  cancellation: AbortController;
  initialized: boolean;
  ingressReady: boolean;
  startupReady: Promise<void>;
  resolveStartupReady: () => void;
  subscriptions: Set<string>;
  eventSeqCounter: number;
  options: StartListenerOptions;
};

export type ListenerRuntime = {
  socket: WebSocket | null;
  transport?: ListenerTransport | null;
  streamSocket?: WebSocket | null;
  streamTransport?: ListenerTransport | null;
  heartbeatInterval: NodeJS.Timeout | null;
  reconnectTimeout: NodeJS.Timeout | null;
  /**
   * Epoch ms of the last `pong` observed from the cloud relay. Used by the
   * heartbeat watchdog to detect a half-open socket (no `close` event) and
   * force a reconnect. `null` until the first pong on a connection.
   */
  lastPongAt: number | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  /** True once the WS has connected at least once. Never reset to false. */
  everConnected: boolean;
  /** Global local mod adapter for desktop/listener surfaces. */
  modAdapter?: ModAdapter | undefined;
  /** Isolated agent-scoped adapters loaded from each agent's MemFS. */
  agentModAdapters?: Map<string, ModAdapter>;
  /** Coalesces concurrent first-loads for one agent's scoped adapter. */
  agentModAdapterLoads?: Map<string, Promise<ModAdapter | null>>;
  sessionId: string;
  /** Increments once for every control/stream reconnect pair. */
  nextConnectionAttempt: number;
  /** Monotonic allocator used for deterministic connection ordering. */
  nextConnectionOrdinal: number;
  /** All currently open listener transports, keyed by explicit identity. */
  connections: Map<ListenerConnectionId, ListenerConnectionState>;
  /** Reverse index for Codex-style conversation subscriptions. */
  connectionIdsByRuntimeKey: Map<string, Set<ListenerConnectionId>>;
  /** Process-scoped transport used by scheduler/channel/background services. */
  processTransport: ListenerTransport | null;
  /** Process-wide services are installed once, regardless of client count. */
  processServicesStarted: boolean;
  /** Invalidates process-service attempts that outlive an outbound connection. */
  processServicesGeneration: number;
  /** Invalidates detached external-tool notifications after an authoritative reset. */
  externalToolNotificationEpochByConversation: Map<string, number>;
  /** Holds detached completions while a conversation reset may still fail. */
  externalToolNotificationBarrierByConversation: Map<string, Promise<void>>;
  /** Coalesces concurrent connection attempts while process services initialize. */
  processServicesReady: Promise<void> | null;
  /** Generation owned by processServicesReady, or null when no attempt is active. */
  processServicesReadyGeneration: number | null;
  /** Reconcile durable interrupted work without importing the turn cycle. */
  scheduleRecordedRecovery?: () => void;
  /** Retry capacity-deferred input-terminal promotion after an ACK frees space. */
  promotePreparedInputTerminals?: () => number;
  /** Rehydrate a committed queued input after volatile enqueue failure. */
  restoreDurableQueuedInputs?: () => number | Promise<number>;
  /** Wake process-owned queue pumps after a delayed durable refill enqueues work. */
  scheduleRestoredQueuePumps?: () => void;
  /** Coalesces capacity-release callbacks into one durable queue refill scan. */
  durableQueueRestoreScheduled?: boolean;
  /** A wake that arrived while an async refill snapshot was in flight. */
  durableQueueRestoreRerunRequested?: boolean;
  /** The single bounded backoff timer for a failed durable queue refill. */
  durableQueueRestoreTimer?: ReturnType<typeof setTimeout>;
  /** Consecutive refill failures in the current bounded retry cycle. */
  durableQueueRestoreFailures?: number;
  serviceCommandHandler:
    | ((command: ServiceCommandRequest) => Promise<ServiceCommandResponse>)
    | null;
  serviceCommandTypes: Set<WsProtocolCommand["type"]>;
  eventSeqCounter: number;
  queueEmitScheduled: boolean;
  pendingQueueEmitScope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  onWsEvent?: StartListenerOptions["onWsEvent"];
  reminderState: SharedReminderState;
  bootWorkingDirectory: string;
  workingDirectoryByConversation: Map<string, string>;
  /** Monotonic signal for cwd changes and rejected stale cwd requests. */
  workingDirectoryRevision?: number;
  /** Per-conversation permission mode state. Mirrors workingDirectoryByConversation. */
  permissionModeByConversation: Map<
    string,
    import("@/websocket/listener/permission-mode").ConversationPermissionModeState
  >;
  /** Per-conversation skill overrides survive idle ConversationRuntime eviction. */
  skillSourcesByConversation: Map<string, SkillSource[]>;
  /** Per-conversation reminder state survives ConversationRuntime eviction. */
  reminderStateByConversation: Map<string, SharedReminderState>;
  /** Per-conversation context tracker survives ConversationRuntime eviction. */
  contextTrackerByConversation: Map<string, ContextTracker>;
  /** Shared recompile coalescing for memory-writing subagents. */
  systemPromptRecompileByConversation: Map<string, Promise<void>>;
  queuedSystemPromptRecompileByConversation: Set<string>;
  connectionId: string | null;
  /** Physical Cloud listener generation currently paired to connectionId. */
  connectionGeneration?: string | null;
  connectionName: string | null;
  conversationRuntimes: Map<string, ConversationRuntime>;
  /**
   * Process-scoped TTL ledger for stable input identities. Its composite key
   * includes the exact conversation runtime key; an explicit Cloud replacement
   * lineage transfers this object across re-registration.
   */
  acceptedInputDispositionLedger: AcceptedInputDispositionLedger;
  /** Live Cloud recovery capabilities, synchronously revoked on disconnect/stop. */
  activeRecoveryClaims?: Set<ActiveRecoveryClaim>;
  /** Bounded pre-ready requestless state keyed by explicit replacement lineage. */
  pendingStartupFramesByLineage: Map<string, StartupFrameHandoff>;
  /** Generation currently owned by each explicit replacement lineage. */
  startupGenerationByLineage: Map<string, number>;
  /** Recent run-to-send snapshots survive idle conversation runtime eviction. */
  clientMessageIdsByRunIdByConversation?: Map<string, Map<string, string[]>>;
  /** Per-conversation worktree directory watchers for CWD auto-detection fallback. */
  worktreeWatcherByConversation: Map<
    string,
    import("@/websocket/listener/worktree-watcher").WorktreeWatcherState
  >;
  /** Agent IDs whose memfs repo has been cloned/pulled this session. Concurrent callers coalesce on the same promise. */
  memfsSyncedAgents: Map<string, Promise<boolean>>;
  /** Agent IDs with an in-flight secrets refresh. Concurrent callers coalesce on the same promise. */
  secretsHydrationByAgent: Map<string, Promise<void>>;
  /** Per-agent timestamp of the last successful secrets hydration. Used for freshness-based caching. */
  secretsHydrationFreshnessByAgent: Map<string, number>;
  /** Agent IDs whose cached secrets are stale and must re-fetch on the next hydration call. */
  secretsDirtyAgents: Set<string>;
  pendingExternalToolCalls: Map<string, PendingExternalToolCall>;
  /** Source handoffs retained briefly so a failed destination can resume. */
  pendingTeleports?: Map<string, PendingTeleport>;
  /**
   * Agent metadata warmups for listen-mode reminders. The cached promise is
   * reused while the listener stays connected so first-turn reminders can join
   * an in-flight sync warmup instead of fetching agent info again.
   */
  agentMetadataByAgent: Map<
    string,
    Promise<{
      name: string | null;
      description: string | null;
      lastRunAt: string | null;
    } | null>
  >;
  lastEmittedStatus: "idle" | "receiving" | "processing" | null;
  /**
   * In-process observers of outbound v2 protocol messages (e.g. the
   * OpenAI-compat HTTP bridge). Each observer receives every emitted message
   * with its resolved runtime scope, independent of socket routing, so
   * protocol consumers can exist without owning a WebSocket.
   */
  streamObservers?: Set<ListenerStreamObserver>;
  /** Unsubscribe from subagent state store (set on socket open, cleared on close). */
  _unsubscribeSubagentState?: (() => void) | undefined;
  /** Unsubscribe from subagent stream events (set on socket open, cleared on close). */
  _unsubscribeSubagentStreamEvents?: (() => void) | undefined;
  /** Unsubscribe from background process state (set on socket open, cleared on close). */
  _unsubscribeBackgroundProcessState?: (() => void) | undefined;
};

export interface InterruptPopulateInput {
  lastExecutionResults: ApprovalResult[] | null;
  lastExecutingToolCallIds: string[];
  lastNeedsUserInputToolCallIds: string[];
  agentId: string | null;
  conversationId: string;
  requestOtid?: string;
}

export interface InterruptToolReturn {
  tool_call_id: string;
  status: "success" | "error";
  tool_return: string;
  stdout?: string[];
  stderr?: string[];
}

export type { DequeuedBatch, QueueBlockedReason, QueueItem };
