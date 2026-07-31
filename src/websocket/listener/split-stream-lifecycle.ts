import { WebSocket } from "ws";
import { isDebugEnabled } from "@/utils/debug";
import { LISTENER_STREAM_OPEN_TIMEOUT_MS } from "./constants";
import { getActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { ListenerRuntime } from "./types";

type TrackListenerError = (
  errorType: string,
  error: unknown,
  context: string,
) => void;

type StreamSocketOpenResult =
  | { status: "open"; transport: ListenerTransport }
  | { status: "closed" }
  | { status: "timed_out"; timeoutMs: number };

export type SplitStreamOpenOutcome =
  | { kind: "ready"; transport: ListenerTransport | null }
  | { kind: "stale" };

function terminateSocketIfOpenOrConnecting(socket: WebSocket | null): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    socket.terminate();
  }
}

export function isCurrentSocketPair(
  runtime: ListenerRuntime,
  controlSocket: WebSocket,
  streamSocket: WebSocket | null,
): boolean {
  return (
    runtime === getActiveRuntime() &&
    !runtime.intentionallyClosed &&
    runtime.socket === controlSocket &&
    runtime.streamSocket === streamSocket
  );
}

export function shouldHandleControlSocketClose(
  runtime: ListenerRuntime,
  controlSocket: WebSocket,
  connectionId: string,
): boolean {
  return (
    runtime === getActiveRuntime() &&
    (runtime.socket === controlSocket ||
      runtime.connections.get(connectionId)?.writer === controlSocket)
  );
}

function terminateCurrentSocketPair(
  runtime: ListenerRuntime,
  controlSocket: WebSocket,
  streamSocket: WebSocket | null,
): void {
  if (!isCurrentSocketPair(runtime, controlSocket, streamSocket)) {
    return;
  }
  runtime.streamTransport = null;
  terminateSocketIfOpenOrConnecting(streamSocket);
  terminateSocketIfOpenOrConnecting(controlSocket);
}

export function terminateControlAfterStreamClose(
  runtime: ListenerRuntime,
  streamSocket: WebSocket,
  code: number,
  reason: Buffer,
): void {
  if (runtime.streamSocket !== streamSocket) {
    return;
  }
  if (code === 1000 && reason.toString() === "Replaced by new connection") {
    runtime.intentionallyClosed = true;
  }
  runtime.streamSocket = null;
  runtime.streamTransport = null;

  // The stream channel has no independent replay or reconnect path. Closing
  // control tears down the paired session so its normal reconnect/bootstrap
  // flow restores one coherent connection instead of silently losing frames.
  terminateSocketIfOpenOrConnecting(runtime.socket);
}

function getStreamOpenTimeoutMs(): number {
  const override = process.env.LETTA_LISTENER_STREAM_OPEN_TIMEOUT_MS;
  if (override !== undefined) {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return LISTENER_STREAM_OPEN_TIMEOUT_MS;
}

async function waitForStreamSocketOpen(
  streamSocket: WebSocket,
): Promise<StreamSocketOpenResult> {
  if (streamSocket.readyState === WebSocket.OPEN) {
    return { status: "open", transport: streamSocket };
  }

  if (
    streamSocket.readyState === WebSocket.CLOSING ||
    streamSocket.readyState === WebSocket.CLOSED
  ) {
    return { status: "closed" };
  }

  const timeoutMs = getStreamOpenTimeoutMs();
  return await new Promise<StreamSocketOpenResult>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    function cleanup() {
      streamSocket.off("open", handleOpen);
      streamSocket.off("error", handleFailure);
      streamSocket.off("close", handleFailure);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    }

    function settle(result: StreamSocketOpenResult) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    }

    function handleOpen() {
      settle({ status: "open", transport: streamSocket });
    }

    function handleFailure() {
      settle({ status: "closed" });
    }

    timeout = setTimeout(() => {
      settle({ status: "timed_out", timeoutMs });
    }, timeoutMs);
    timeout.unref?.();

    streamSocket.once("open", handleOpen);
    streamSocket.once("error", handleFailure);
    streamSocket.once("close", handleFailure);
  });
}

export async function prepareSplitStreamTransport({
  runtime,
  controlSocket,
  streamSocket,
  trackListenerError,
}: {
  runtime: ListenerRuntime;
  controlSocket: WebSocket;
  streamSocket: WebSocket | null;
  trackListenerError: TrackListenerError;
}): Promise<SplitStreamOpenOutcome> {
  if (!isCurrentSocketPair(runtime, controlSocket, streamSocket)) {
    return { kind: "stale" };
  }
  if (!streamSocket) {
    return { kind: "ready", transport: null };
  }

  const result = await waitForStreamSocketOpen(streamSocket);
  if (!isCurrentSocketPair(runtime, controlSocket, streamSocket)) {
    return { kind: "stale" };
  }
  if (result.status !== "open") {
    const message =
      result.status === "timed_out"
        ? `Stream WebSocket did not open within ${result.timeoutMs}ms; reconnecting paired listener sockets`
        : "Stream WebSocket closed before the paired listener sockets finished opening; reconnecting paired listener sockets";
    trackListenerError(
      result.status === "timed_out"
        ? "listener_stream_open_timeout"
        : "listener_stream_open_failed",
      new Error(message),
      "listener_stream_socket_open",
    );
    if (isDebugEnabled()) {
      console.error(`[Listen] ${message}`);
    }
    terminateCurrentSocketPair(runtime, controlSocket, streamSocket);
    return { kind: "stale" };
  }

  runtime.streamTransport = result.transport;
  return { kind: "ready", transport: result.transport };
}

export function handleListenerSocketOpenFailure({
  runtime,
  controlSocket,
  streamSocket,
  error,
  trackListenerError,
}: {
  runtime: ListenerRuntime;
  controlSocket: WebSocket;
  streamSocket: WebSocket | null;
  error: unknown;
  trackListenerError: TrackListenerError;
}): void {
  if (!isCurrentSocketPair(runtime, controlSocket, streamSocket)) {
    return;
  }
  trackListenerError(
    "listener_open_handler_failed",
    error,
    "listener_socket_open",
  );
  if (isDebugEnabled()) {
    console.error("[Listen] WebSocket open handler failed:", error);
  }
  terminateCurrentSocketPair(runtime, controlSocket, streamSocket);
}
