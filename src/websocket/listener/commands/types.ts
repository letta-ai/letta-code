import type WebSocket from "ws";

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
