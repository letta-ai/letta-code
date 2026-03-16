import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import type { ApprovalResult } from "../../agent/approval-execution";
import type { ApprovalRequest } from "../../cli/helpers/stream";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueItem,
  QueueRuntime,
} from "../../queue/queueRuntime";
import type { SharedReminderState } from "../../reminders/state";
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
  messages: Array<
    (MessageCreate & { client_message_id?: string }) | ApprovalCreate
  >;
}

export interface ModeChangePayload {
  mode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
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
};

export type RecoveredApprovalState = {
  agentId: string;
  conversationId: string;
  approvalsByRequestId: Map<string, RecoveredPendingApproval>;
  pendingRequestIds: Set<string>;
  responsesByRequestId: Map<string, ApprovalResponseBody>;
};

export type ListenerRuntime = {
  socket: WebSocket | null;
  heartbeatInterval: NodeJS.Timeout | null;
  reconnectTimeout: NodeJS.Timeout | null;
  intentionallyClosed: boolean;
  hasSuccessfulConnection: boolean;
  messageQueue: Promise<void>;
  pendingApprovalResolvers: Map<string, PendingApprovalResolver>;
  recoveredApprovalState: RecoveredApprovalState | null;
  sessionId: string;
  eventSeqCounter: number;
  lastStopReason: string | null;
  isProcessing: boolean;
  activeAgentId: string | null;
  activeConversationId: string | null;
  activeWorkingDirectory: string | null;
  activeRunId: string | null;
  activeRunStartedAt: string | null;
  activeAbortController: AbortController | null;
  cancelRequested: boolean;
  queueRuntime: QueueRuntime;
  queuedMessagesByItemId: Map<string, IncomingMessage>;
  queuePumpActive: boolean;
  queuePumpScheduled: boolean;
  queueEmitScheduled: boolean;
  pendingQueueEmitScope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  pendingTurns: number;
  onWsEvent?: StartListenerOptions["onWsEvent"];
  isRecoveringApprovals: boolean;
  loopStatus: LoopStatus;
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
  reminderState: SharedReminderState;
  bootWorkingDirectory: string;
  workingDirectoryByConversation: Map<string, string>;
  connectionId: string | null;
  connectionName: string | null;
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
