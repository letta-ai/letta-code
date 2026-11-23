import WebSocket from "ws";
import { getListenerSocketOptions } from "./constants";

export function createListenerSocket(url: URL, apiKey: string): WebSocket {
  const options = getListenerSocketOptions(apiKey);
  const socket = new WebSocket(url.toString(), options);
  const timer = setTimeout(() => {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
  }, options.handshakeTimeout);
  timer.unref?.();
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
