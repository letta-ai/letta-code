import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import type {
  ApprovalDecision,
  ApprovalResult,
} from "@/agent/approval-execution";
import type { SkillSource } from "@/agent/skill-sources";
import type { ChannelTurnSource } from "@/channels/types";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ModAdapter } from "@/mods/mod-adapter";
import type { ApprovalContext } from "@/permissions/analyzer";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
  QueueRuntime,
} from "@/queue/queue-runtime";
import type { SharedReminderState } from "@/reminders/state";
import type { ToolsetName, ToolsetPreference } from "@/tools/toolset";
import type {
  ApprovalResponseBody,
  ControlRequest,
  ExternalToolCallResult,
  LoopStatus,
  RuntimeScope,
  StopReasonType,
  WsProtocolCommand,
} from "@/types/protocol_v2";
import type { ActiveChannelTurn } from "./channel-turn-session";
import type { ListenerTransport } from "./transport";
import type { TurnLifecycle } from "./turn-lifecycle";

export interface StartListenerOptions {
  connectionId: string;
  wsUrl: string;
  supportsSplitStatusChannels?: boolean;
  deviceId: string;
  connectionName: string;
  onConnected: (connectionId: string) => void;
  onDisconnected: () => void;
  onNeedsReregister?: () => void;
  /**
   * Terminal supersession (close code 4009): a newer listener registered for
   * this environment slot and the relay fenced this process out. The process
   * must stop — never re-register (that would steal the lease back and
   * restart the lease ping-pong, LET-10024). Falls back to onError when
   * unset.
   */
  onSuperseded?: () => void;
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

export interface IncomingMessage {
  type: "message";
  agentId?: string;
  conversationId?: string;
  channelTurnSources?: ChannelTurnSource[];
  clientToolAllowlist?: string[];
  externalToolScopeIds?: string[];
  messages: Array<
    (MessageCreate & { client_message_id?: string }) | ApprovalCreate
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
}

export type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

export interface PendingExternalToolCall {
  resolve: (result: ExternalToolCallResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface ModeChangePayload {
  mode: "standard" | "acceptEdits" | "unrestricted";
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
  resolve: (response: ApprovalResponseBody) => void;
  reject: (reason: Error) => void;
  controlRequest?: ControlRequest;
};

export type RecoveredPendingApproval = {
  approval: ApprovalRequest;
  controlRequest: ControlRequest;
  approvalContext: ApprovalContext | null;
};

export type RecoveredApprovalState = {
  agentId: string;
  conversationId: string;
  approvalsByRequestId: Map<string, RecoveredPendingApproval>;
  pendingRequestIds: Set<string>;
  responsesByRequestId: Map<string, ApprovalResponseBody>;
  autoDecisions?: ApprovalDecision[];
  allApprovals?: ApprovalRequest[];
};

export type ConversationRuntime = {
  listener: ListenerRuntime;
  key: string;
  agentId: string | null;
  conversationId: string;
  /** Runtime-scoped SDK override. Undefined uses the process defaults. */
  skillSources: SkillSource[] | undefined;
  activeChannelTurn: ActiveChannelTurn | null;
  turnLifecycle: TurnLifecycle;
  messageQueue: Promise<void>;
  pendingApprovalResolvers: Map<string, PendingApprovalResolver>;
  recoveredApprovalState: RecoveredApprovalState | null;
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
  queuePumpActive: boolean;
  queuePumpScheduled: boolean;
  pendingTurns: number;
  readonly loopStatus: LoopStatus;
  currentToolset: ToolsetName | null;
  currentToolsetPreference: ToolsetPreference;
  currentLoadedTools: string[];
  pendingApprovalBatchByToolCallId: Map<string, string>;
  pendingInterruptedResults: Array<ApprovalResult> | null;
  pendingInterruptedContext: {
    agentId: string;
    conversationId: string;
    continuationEpoch: number;
  } | null;
  continuationEpoch: number;
  pendingInterruptedToolCallIds: string[] | null;
  /** Per-conversation reminder state (session-context, agent-info, etc.). */
  reminderState: SharedReminderState;
  /** Per-conversation tracker for compaction/reflection cadence. */
  contextTracker: ContextTracker;
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
  connectionName: string | null;
  conversationRuntimes: Map<string, ConversationRuntime>;
  approvalRuntimeKeyByRequestId: Map<string, string>;
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
  pendingExternalToolCalls?: Map<string, PendingExternalToolCall>;
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
  /** Unsubscribe from subagent state store (set on socket open, cleared on close). */
  _unsubscribeSubagentState?: (() => void) | undefined;
  /** Unsubscribe from subagent stream events (set on socket open, cleared on close). */
  _unsubscribeSubagentStreamEvents?: (() => void) | undefined;
};

export interface InterruptPopulateInput {
  lastExecutionResults: ApprovalResult[] | null;
  lastExecutingToolCallIds: string[];
  lastNeedsUserInputToolCallIds: string[];
  agentId: string;
  conversationId: string;
}

export interface InterruptToolReturn {
  tool_call_id: string;
  status: "success" | "error";
  tool_return: string;
  stdout?: string[];
  stderr?: string[];
}

export type { DequeuedBatch, QueueBlockedReason, QueueItem };
