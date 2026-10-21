import WebSocket from "ws";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import { isDebugEnabled } from "@/utils/debug";

export function safeSocketSend(
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    const serialized =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    socket.send(serialized);
    return true;
  } catch (error) {
    trackBoundaryError({ errorType, error, context });
    if (isDebugEnabled()) {
      console.error(`[Listen] ${context} send failed:`, error);
    }
    return false;
  }
}
