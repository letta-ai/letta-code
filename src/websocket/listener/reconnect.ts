import WebSocket from "ws";
import { LISTENER_RECONNECT_STALL_TIMEOUT_MS } from "./constants";
import {
  clearReconnectDelay,
  clearReconnectWatchdog,
  getActiveRuntime,
} from "./runtime";
import type { ListenerRuntime, StartListenerOptions } from "./types";

let reconnectStallTimeoutMs = LISTENER_RECONNECT_STALL_TIMEOUT_MS;

export function canContinueListenerReconnect(
  runtime: ListenerRuntime,
): boolean {
  return (
    runtime === getActiveRuntime() &&
    !runtime.intentionallyClosed &&
    !runtime.reregisterRequested
  );
}

export function isCurrentListenerSocket(
  runtime: ListenerRuntime,
  socket: WebSocket,
): boolean {
  return runtime === getActiveRuntime() && runtime.socket === socket;
}

export function canOpenListenerSocket(
  runtime: ListenerRuntime,
  socket: WebSocket,
): boolean {
  return (
    canContinueListenerReconnect(runtime) &&
    isCurrentListenerSocket(runtime, socket)
  );
}

export async function waitForListenerReconnectDelay(
  runtime: ListenerRuntime,
  delayMs: number,
): Promise<boolean> {
  let cancelled = false;

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (runtime.reconnectTimeout === timeout) {
        runtime.reconnectTimeout = null;
      }
      if (runtime.reconnectDelayCancel === cancel) {
        runtime.reconnectDelayCancel = null;
      }
      resolve();
    };
    const timeout = setTimeout(settle, delayMs);
    const cancel = () => {
      cancelled = true;
      clearTimeout(timeout);
      settle();
    };
    runtime.reconnectTimeout = timeout;
    runtime.reconnectDelayCancel = cancel;
  });

  return !cancelled;
}

export function armListenerReconnectWatchdog(
  runtime: ListenerRuntime,
  opts: Pick<StartListenerOptions, "onError" | "onLog" | "onNeedsReregister">,
): void {
  if (
    runtime.reconnectWatchdogTimeout ||
    !runtime.everConnected ||
    runtime.intentionallyClosed
  ) {
    return;
  }

  const timeout = setTimeout(() => {
    if (runtime.reconnectWatchdogTimeout === timeout) {
      runtime.reconnectWatchdogTimeout = null;
    }
    if (
      !canContinueListenerReconnect(runtime) ||
      runtime.hasSuccessfulConnection ||
      runtime.transport
    ) {
      return;
    }

    requestListenerReregistration(runtime, opts);
  }, reconnectStallTimeoutMs);
  timeout.unref?.();
  runtime.reconnectWatchdogTimeout = timeout;
}

export function requestListenerReregistration(
  runtime: ListenerRuntime,
  opts: Pick<StartListenerOptions, "onError" | "onLog" | "onNeedsReregister">,
  message = "Listener reconnect made no progress; re-registering the environment",
): boolean {
  if (
    runtime !== getActiveRuntime() ||
    runtime.intentionallyClosed ||
    runtime.reregisterRequested
  ) {
    return false;
  }

  runtime.reregisterRequested = true;
  clearReconnectDelay(runtime);
  clearReconnectWatchdog(runtime);
  opts.onLog?.(message);

  const sockets = [runtime.socket, runtime.streamSocket];
  for (const socket of sockets) {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.terminate();
    }
  }

  if (!opts.onNeedsReregister) {
    opts.onError(new Error(message));
    return true;
  }
  let reregistering: void | Promise<void>;
  try {
    reregistering = opts.onNeedsReregister();
  } catch (error) {
    opts.onError(error instanceof Error ? error : new Error(String(error)));
    return true;
  }
  Promise.resolve(reregistering).catch((error: unknown) => {
    opts.onError(error instanceof Error ? error : new Error(String(error)));
  });
  return true;
}

export const __listenerReconnectTestUtils = {
  setStallTimeoutMs(timeoutMs: number): void {
    reconnectStallTimeoutMs = timeoutMs;
  },
  reset(): void {
    reconnectStallTimeoutMs = LISTENER_RECONNECT_STALL_TIMEOUT_MS;
  },
  clearWatchdog(runtime: ListenerRuntime): void {
    clearReconnectWatchdog(runtime);
  },
};
