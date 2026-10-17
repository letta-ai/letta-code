/**
 * Shared types for the listener message router and its input-frame routing
 * module, kept in a leaf module so message-router.ts and
 * input-frame-router.ts do not depend on each other (cycle check).
 */
import type WebSocket from "ws";
import type {
  AbortMessageCommand,
  ApprovalResponseBody,
  ChangeDeviceStateCommand,
} from "@/types/protocol_v2";
import type { ListenerTransport } from "./transport";
import type { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerConnectionId,
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
  SyncReplayOptions,
} from "./types";

export type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

export type RunDetachedListenerTask = (
  commandName: string,
  task: () => Promise<void>,
) => void;

export type TrackListenerError = (
  errorType: string,
  error: unknown,
  context: string,
) => void;

export type FileCommandSession = {
  handle(parsed: unknown): boolean;
};
export type RuntimeScope = {
  agent_id: string | null;
  conversation_id: string;
};

export type ParsedRuntimeScope = RuntimeScope | null;

export type MessageRouterParams = {
  runtime: ListenerRuntime;
  socket: WebSocket;
  connectionId?: ListenerConnectionId;
  lineageId?: string;
  opts: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
  fileCommandSession: FileCommandSession;
  getParsedRuntimeScope: (parsed: unknown) => ParsedRuntimeScope;
  replaySyncStateForRuntime: (
    listenerRuntime: ListenerRuntime,
    socket: WebSocket,
    scope: RuntimeScope,
    opts?: SyncReplayOptions,
  ) => Promise<void>;
  getOrCreateScopedRuntime: (
    listener: ListenerRuntime,
    agentId?: string | null,
    conversationId?: string | null,
  ) => ConversationRuntime;
  handleApprovalResponseInput: (
    listener: ListenerRuntime,
    params: {
      runtime: {
        agent_id?: string | null;
        conversation_id?: string | null;
      };
      response: ApprovalResponseBody;
      connectionId: ListenerConnectionId;
      socket: ListenerTransport;
      opts: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      };
      processQueuedTurn: ProcessQueuedTurn;
    },
  ) => Promise<boolean>;
  handleChangeDeviceStateInput: (
    listener: ListenerRuntime,
    params: {
      command: ChangeDeviceStateCommand;
      connectionId: ListenerConnectionId;
      socket: WebSocket;
      opts: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      };
      processQueuedTurn: ProcessQueuedTurn;
    },
  ) => Promise<boolean>;
  handleAbortMessageInput: (
    listener: ListenerRuntime,
    params: {
      command: AbortMessageCommand;
      connectionId: ListenerConnectionId;
      socket: WebSocket;
      opts: {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      };
      processQueuedTurn: ProcessQueuedTurn;
    },
  ) => Promise<boolean>;
  stampInboundUserMessageOtids: (incoming: IncomingMessage) => IncomingMessage;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
  trackListenerError: TrackListenerError;
  processIncomingMessage?: typeof handleIncomingMessage;
};
