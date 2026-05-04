import type WebSocket from "ws";
import type { ConversationRuntime, ListenerRuntime } from "../types";

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

export type GetOrCreateScopedRuntime = (
  listener: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
) => ConversationRuntime;
