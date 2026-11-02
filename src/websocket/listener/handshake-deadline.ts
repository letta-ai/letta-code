import WebSocket from "ws";
import { getListenerSocketOptions } from "./constants";

/**
 * Opens a listener WebSocket whose opening handshake cannot hang forever.
 * `handshakeTimeout` covers the `ws` library, but Bun substitutes its native
 * WebSocket for `ws` and ignores that option, so a timer also terminates the
 * socket if it is still CONNECTING. Either way it errors and closes, and the
 * existing close handler retries.
 */
export function createListenerSocket(url: URL, apiKey: string): WebSocket {
  const options = getListenerSocketOptions(apiKey);
  const socket = new WebSocket(url.toString(), options);
  const timer = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }, options.handshakeTimeout);
  timer.unref?.();
  // Not `once`: Bun's ws shim double-fires later `open` listeners after it.
  const clear = (): void => {
    clearTimeout(timer);
    for (const event of ["open", "close", "error"] as const) {
      socket.off(event, clear);
    }
  };
  for (const event of ["open", "close", "error"] as const) {
    socket.on(event, clear);
  }
  return socket;
}
