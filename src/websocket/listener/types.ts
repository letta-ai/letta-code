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
import type { AppServerProtocolCommand } from "@/types/app-server-protocol";
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
  organizationId?: string;
  connectionIdCanResume?: boolean;
  skillsDirectory?: string;
  onConnected: (connectionId: string) => void | Promise<void>;
  onConnectionReady?: (
    connection: ListenerConnectionState,
  ) => void | Promise<void>;
  onDisconnected: () => void;
  onNeedsReregister?: (replacement?: ListenerClientReplacement) => void;
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

export type SyncReplayOptions = {
  recoverApprovals?: boolean;
  resumeInterruptedTurn?: boolean;
  forceDeviceStatus?: boolean;
  onStatusChange?: StartListenerOptions["onStatusChange"];
  connectionId?: string;
};

export interface IncomingMessage {
  receivedAt?: number;
  type: "message";
  connectionId?: ListenerConnectionId;
  agentId?: string | null;
  conversationId?: string;
  noCoalesce?: boolean;
  processOwnedTurn?: boolean;
  imageFailureMode?: "strict" | "drop";
  clientToolAllowlist?: string[];
  clientToolset?: ClientToolsetConfig;
  clientPreferences?: import("@/types/client-preferences").ClientPreferences;
  excludeInteractiveTools?: boolean;
  responseFormat?: Record<string, unknown>;
  gitAttribution?: import("@/types/git-attribution").GitAttribution;
  messages: Array<
    (AttributedMessageCreate & { client_message_id?: string }) | ApprovalCreate
  >;
  actingUserId?: string;
  suppressActingUserFallback?: boolean;
  durableInputIdentities?: readonly InputIdentity[];
  terminalConsumerIds?: readonly string[];
  mcpOriginatorSuperRunId?: string;
  mcpOriginatorTokenPresent?: boolean;
}

export type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

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
  isOwningTurnCurrent?: () => boolean;
  connectionId: ListenerConnectionId;
  requestFrame: string;
  sentOn: ListenerTransport;
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

export type ServerMessage = AppServerProtocolCommand;

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
  actingUserId?: string;
  autoDecisions?: ApprovalDecision[];
  allApprovals?: ApprovalRequest[];
  durableInputIdentities?: readonly InputIdentity[];
  terminalConsumerIds?: readonly string[];
  interruptedRevision?: string;
  recoveryLineageId?: string;
  recoveryRevisionToken?: string;
  recoveryUsesIndependentSuccessor?: boolean;
};

export type AcceptedInputDisposition = "started" | "queued";

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
  identity: InputIdentity;
  incoming: IncomingMessage;
  actingUserId?: string;
};

export type DurablePreparedInputTerminal = {
  preparedAt?: number;
  preparationSequence?: number;
  inputDispositionKeys?: string[];
  publicationClaimed?: true;
  persistWithoutConsumers?: true;
  suppressConsumerPublication?: true;
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
    terminalIdentity?: string;
    interruptedRevision?: string;
    recoveryLineageId?: string;
    interruptedAuthorityRevision?: string;
    preparationSequence?: number;
  };
};

export type InterruptedTerminalAuthority = {
  interruptedRevision: string;
  authorityRevision: string;
  recoveryAuthorityBaseRevision?: string;
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
  queuedInput?: DurableQueuedInput;
  replayCompleted?: true;
  preparedTerminal?: DurablePreparedInputTerminal;
  legacyAuthorityQuarantine?: {
    scope: { agentId: string | null; conversationId: string };
    recoveryLineageId: string;
    interruptedRevision: string;
    expiresAt: number;
  };
  completedTerminalRevision?: string;
  completedTerminalAuthority?: InterruptedTerminalAuthority;
};

export type ActiveRecoveryClaim = {
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly owned: boolean;
  release(): Promise<void>;
  revoke(): void;
  abandon(): void;
};

export type AcceptedInputDispositionLedger = {
  entries: Map<string, AcceptedInputDispositionEntry>;
  scopeCounts: Map<string, number>;
  quarantinedCount: number;
  expiryQueue: Array<{ key: string; expiresAt: number; generation: number }>;
  expiryQueueHead: number;
  nextGeneration: number;
  abandonedReservations: Map<
    string,
    { generation: number; token: string | undefined }
  >;
  persistentPath: string | null;
};

export type InputDispositionReservation = {
  key: string;
  generation: number;
  runtimeKey: string;
  token?: string;
  ownerPid?: number;
  ownerProcessStart?: string | null;
};

export type StartupIngressOwner = {
  readonly lineageId: string;
  readonly generation: number;
  readonly handoffEnabled: boolean;
};

export type StartupFrameCapacity = "frame_count" | "byte_count";

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
  skillSources: SkillSource[] | undefined;
  bundledSkills?: string[];
  workspaceSandbox: RuntimeWorkspaceSandbox | undefined;
  executionSettings?: RuntimeExecutionSettings;
  activeConnectionId: ListenerConnectionId | null;
  turnLifecycle: TurnLifecycle;
  messageQueue: Promise<void>;
  pendingApprovalResolvers: Map<string, PendingApprovalResolver>;
  recoveredApprovalState: RecoveredApprovalState | null;
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
  dequeuedClientMessageIdsByBatchId: Map<string, string[]>;
  dequeuedInputIdentitiesByBatchId: Map<string, InputIdentity[]>;
  queuePumpActive: boolean;
  queuePumpScheduled: boolean;
  pendingInboundDispatches: number;
  pendingTurns: number;
  readonly loopStatus: LoopStatus;
  currentToolset: ToolsetName | null;
  currentToolsetPreference: ToolsetPreference;
  currentLoadedTools: string[];
  currentAvailableSkills: AvailableSkillSummary[];
  transientChannelRuntimeTools: boolean;
  pendingApprovalBatchByToolCallId: Map<string, string>;
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
  pendingTerminalDeliveryCount: number;
  reminderState: SharedReminderState;
  contextTracker: ContextTracker;
};

export type ListenerConnectionId = string;

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

export type ListenerConnectionState = {
  id: ListenerConnectionId;
  ordinal: number;
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
  lastPongAt: number | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  everConnected: boolean;
  modAdapter?: ModAdapter | undefined;
  agentModAdapters?: Map<string, ModAdapter>;
  agentModAdapterLoads?: Map<string, Promise<ModAdapter | null>>;
  sessionId: string;
  nextConnectionAttempt: number;
  nextConnectionOrdinal: number;
  connections: Map<ListenerConnectionId, ListenerConnectionState>;
  connectionIdsByRuntimeKey: Map<string, Set<ListenerConnectionId>>;
  processTransport: ListenerTransport | null;
  processServicesStarted: boolean;
  processServicesGeneration: number;
  externalToolNotificationEpochByConversation: Map<string, number>;
  externalToolNotificationBarrierByConversation: Map<string, Promise<void>>;
  processServicesReady: Promise<void> | null;
  processServicesReadyGeneration: number | null;
  scheduleRecordedRecovery?: () => void;
  promotePreparedInputTerminals?: () => number;
  restoreDurableQueuedInputs?: () => number | Promise<number>;
  scheduleRestoredQueuePumps?: () => void;
  durableQueueRestoreScheduled?: boolean;
  durableQueueRestoreRerunRequested?: boolean;
  durableQueueRestoreTimer?: ReturnType<typeof setTimeout>;
  durableQueueRestoreFailures?: number;
  serviceCommandHandler:
    | ((command: ServiceCommandRequest) => Promise<ServiceCommandResponse>)
    | null;
  serviceCommandTypes: Set<AppServerProtocolCommand["type"]>;
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
  workingDirectoryRevision?: number;
  permissionModeByConversation: Map<
    string,
    import("@/websocket/listener/permission-mode").ConversationPermissionModeState
  >;
  skillSourcesByConversation: Map<
    string,
    { sources: SkillSource[]; bundledSkills?: string[] }
  >;
  reminderStateByConversation: Map<string, SharedReminderState>;
  contextTrackerByConversation: Map<string, ContextTracker>;
  systemPromptRecompileByConversation: Map<string, Promise<void>>;
  queuedSystemPromptRecompileByConversation: Set<string>;
  connectionId: string | null;
  connectionGeneration?: string | null;
  connectionName: string | null;
  conversationRuntimes: Map<string, ConversationRuntime>;
  acceptedInputDispositionLedger: AcceptedInputDispositionLedger;
  activeRecoveryClaims?: Set<ActiveRecoveryClaim>;
  pendingStartupFramesByLineage: Map<string, StartupFrameHandoff>;
  startupGenerationByLineage: Map<string, number>;
  clientMessageIdsByRunIdByConversation?: Map<string, Map<string, string[]>>;
  worktreeWatcherByConversation: Map<
    string,
    import("@/websocket/listener/worktree-watcher").WorktreeWatcherState
  >;
  memfsSyncedAgents: Map<string, Promise<boolean>>;
  secretsHydrationByAgent: Map<string, Promise<void>>;
  secretsHydrationFreshnessByAgent: Map<string, number>;
  secretsDirtyAgents: Set<string>;
  pendingExternalToolCalls: Map<string, PendingExternalToolCall>;
  pendingTeleports?: Map<string, PendingTeleport>;
  agentMetadataByAgent: Map<
    string,
    Promise<{
      name: string | null;
      description: string | null;
      lastRunAt: string | null;
    } | null>
  >;
  lastEmittedStatus: "idle" | "receiving" | "processing" | null;
  streamObservers?: Set<ListenerStreamObserver>;
  _unsubscribeSubagentState?: (() => void) | undefined;
  _unsubscribeSubagentStreamEvents?: (() => void) | undefined;
  _unsubscribeBackgroundProcessState?: (() => void) | undefined;
  _stopDiskSpaceWatch?: (() => void) | undefined;
};

export interface InterruptPopulateInput {
  lastExecutionResults: ApprovalResult[] | null;
  lastExecutingToolCallIds: string[];
  lastNeedsUserInputToolCallIds: string[];
  agentId: string | null;
  conversationId: string;
  requestOtid?: string;
  denialReason?: string;
}

export interface InterruptToolReturn {
  tool_call_id: string;
  status: "success" | "error";
  tool_return: string;
  stdout?: string[];
  stderr?: string[];
}

export type { DequeuedBatch, QueueBlockedReason, QueueItem };

export type ConnectedListenerOptions = Pick<
  StartListenerOptions,
  | "connectionId"
  | "onConnected"
  | "onLog"
  | "onConnectionReady"
  | "onStatusChange"
  | "onWsEvent"
>;

export interface ConnectedListenerRuntimeOptions {
  startStartupDeadline?: boolean;
  startHeartbeat?: boolean;
  startCronScheduler?: boolean;
  startProcessServices?: boolean;
  streamTransport?: ListenerTransport | null;
  emitInitialState?: boolean;
  updateReconnectState?: boolean;
  activateIngress?: () => Promise<boolean>;
}
