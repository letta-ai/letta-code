import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import type {
  ApprovalDecision,
  ApprovalResult,
} from "../../agent/approval-execution";
import type { ChannelTurnSource } from "../../channels/types";
import type { ContextTracker } from "../../cli/helpers/contextTracker";
import type { ApprovalRequest } from "../../cli/helpers/stream";
import type { ApprovalContext } from "../../permissions/analyzer";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
  QueueRuntime,
} from "../../queue/queueRuntime";
import type { SharedReminderState } from "../../reminders/state";
import type { ToolsetName, ToolsetPreference } from "../../tools/toolset";
import type {
  ApprovalResponseBody,
  ControlRequest,
  LoopStatus,
  RuntimeScope,
  WsProtocolCommand,
} from "../../types/protocol_v2";

export interface StartListenerOptions {
  connectionId: string;
  wsUrl: string;
  deviceId: string;
  connectionName: string;
  onConnected: (connectionId: string) => void;
  onDisconnected: () => void;
  onNeedsReregister?: () => void;
  onError: (error: Error) => void;
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void;
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
  messages: Array<
    (MessageCreate & { client_message_id?: string }) | ApprovalCreate
  >;
}

export interface ModeChangePayload {
  mode: "default" | "acceptEdits" | "plan" | "memory" | "bypassPermissions";
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
  messageQueue: Promise<void>;
  pendingApprovalResolvers: Map<string, PendingApprovalResolver>;
  pendingApprovalSourcesByRequestId: Map<string, ChannelTurnSource[]>;
  recoveredApprovalState: RecoveredApprovalState | null;
  lastStopReason: string | null;
  isProcessing: boolean;
  activeWorkingDirectory: string | null;
  activeRunId: string | null;
  activeRunStartedAt: string | null;
  activeAbortController: AbortController | null;
  cancelRequested: boolean;
  queueRuntime: QueueRuntime;
  queuedMessagesByItemId: Map<string, IncomingMessage>;
  queuePumpActive: boolean;
  queuePumpScheduled: boolean;
  pendingTurns: number;
  isRecoveringApprovals: boolean;
  loopStatus: LoopStatus;
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
  activeExecutingToolCallIds: string[];
  pendingInterruptedToolCallIds: string[] | null;
  activeChannelTurnSources: ChannelTurnSource[] | null;
  /** Per-conversation reminder state (session-context, agent-info, etc.). */
  reminderState: SharedReminderState;
  /** Per-conversation tracker for compaction/reflection cadence. */
  contextTracker: ContextTracker;
};

export type ListenerRuntime = {
  socket: WebSocket | null;
  heartbeatInterval: NodeJS.Timeout | null;
  reconnectTimeout: NodeJS.Timeout | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  /** True once the WS has connected at least once. Never reset to false. */
  everConnected: boolean;
  sessionId: string;
  eventSeqCounter: number;
  lastStopReason: string | null;
  queueEmitScheduled: boolean;
  pendingQueueEmitScope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  onWsEvent?: StartListenerOptions["onWsEvent"];
  reminderState: SharedReminderState;
  bootWorkingDirectory: string;
  workingDirectoryByConversation: Map<string, string>;
  /** Per-conversation permission mode state. Mirrors workingDirectoryByConversation. */
  permissionModeByConversation: Map<
    string,
    import("./permissionMode").ConversationPermissionModeState
  >;
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
    import("./worktree-watcher").WorktreeWatcherState
  >;
  /** Agent IDs whose memfs repo has been cloned/pulled this session. Concurrent callers coalesce on the same promise. */
  memfsSyncedAgents: Map<string, Promise<void>>;
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
