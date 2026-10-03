import { WebSocket } from "ws";
import { isDebugEnabled } from "@/utils/debug";
import { LISTENER_STREAM_OPEN_TIMEOUT_MS } from "./constants";
import { getActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { ListenerRuntime } from "./types";

const rolloutSkewRetries = new WeakSet<ListenerRuntime>();

export function consumeRolloutSkewRetry(runtime: ListenerRuntime): boolean {
  const pending = rolloutSkewRetries.has(runtime);
  rolloutSkewRetries.delete(runtime);
  return pending;
}

type TrackListenerError = (
  errorType: string,
  error: unknown,
  context: string,
) => void;

export interface ListenerPairIdentity {
  connectionGeneration: string;
  connectionAttempt: number;
}

export interface ListenerReadyMessage {
  type: "listener_ready";
  connection_generation: string;
  connection_attempt: number;
  connection_incarnation?: string;
}

type PairedSocketAcceptanceResult =
  | { status: "accepted"; connectionIncarnation: string | undefined }
  | { status: "closed" }
  | { status: "mismatched" }
  | { status: "timed_out"; timeoutMs: number };

type StreamSocketOpenResult =
  | { status: "open"; transport: ListenerTransport }
  | { status: "closed" }
  | { status: "timed_out"; timeoutMs: number };

export type SplitStreamOpenOutcome =
  | {
      kind: "ready";
      transport: ListenerTransport | null;
      streamSocket?: undefined;
    }
  | { kind: "stale" };

export type PairedListenerOpenOutcome =
  | {
      kind: "ready";
      transport: ListenerTransport;
      streamSocket: WebSocket;
    }
  | { kind: "stale" };

export function createListenerPairIdentity(
  runtime: ListenerRuntime,
): ListenerPairIdentity {
  runtime.nextConnectionAttempt += 1;
  return {
    connectionGeneration: crypto.randomUUID(),
    connectionAttempt: runtime.nextConnectionAttempt,
  };
}

export function applyListenerPairIdentity(
  url: URL,
  identity: ListenerPairIdentity,
): void {
  url.searchParams.set("connectionGeneration", identity.connectionGeneration);
  url.searchParams.set("connectionAttempt", String(identity.connectionAttempt));
}

export function applyListenerStreamIncarnation(
  url: URL,
  connectionIncarnation: string | undefined,
): void {
  if (connectionIncarnation)
    url.searchParams.set("connectionIncarnation", connectionIncarnation);
}

export function parseListenerReadyMessage(
  data: WebSocket.RawData,
): ListenerReadyMessage | null {
  try {
    const parsed = JSON.parse(data.toString()) as Partial<ListenerReadyMessage>;
    if (
      parsed.type === "listener_ready" &&
      typeof parsed.connection_generation === "string" &&
      typeof parsed.connection_attempt === "number" &&
      Number.isInteger(parsed.connection_attempt) &&
      parsed.connection_attempt > 0 &&
      (parsed.connection_incarnation === undefined ||
        (typeof parsed.connection_incarnation === "string" &&
          parsed.connection_incarnation.length > 0))
    ) {
      return parsed as ListenerReadyMessage;
    }
  } catch {
    // Other frames belong to the normal listener message parser.
  }
  return null;
}

/**
 * Opens a listener stream socket with an error sink armed for its whole life.
 * Its other error listeners come and go (the acceptance wait drops its own on
 * listener_ready, persistent handlers attach only once the pair is ready, and
 * reconnect cleanup strips handlers), and a rejected, stale, replaced or failed
 * stream can deliver a late ErrorEvent even after close. Uncaught, that kills
 * the CLI. Real errors are still reported by the other handlers while attached.
 */
export function openListenerStreamSocket(
  url: string,
  options: WebSocket.ClientOptions,
): WebSocket {
  const socket = new WebSocket(url, options);
  socket.on("error", () => {});
  return socket;
}

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

export function retainRejectedStreamErrorSink(streamSocket: WebSocket): void {
  // Bun/ws can deliver an ErrorEvent queued before close only after close has
  // fired. Keep the sink for this discarded socket's remaining lifetime; the
  // detached socket and handler are collected together.
  streamSocket.on("error", () => undefined);
}

function terminateRejectedStreamPair(
  runtime: ListenerRuntime,
  controlSocket: WebSocket,
  streamSocket: WebSocket,
): void {
  retainRejectedStreamErrorSink(streamSocket);
  terminateCurrentSocketPair(runtime, controlSocket, streamSocket);
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

async function waitForPairedSocketAcceptance(
  socket: WebSocket,
  identity: ListenerPairIdentity,
): Promise<PairedSocketAcceptanceResult> {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return { status: "closed" };
  }
  const timeoutMs = getStreamOpenTimeoutMs();
  return await new Promise<PairedSocketAcceptanceResult>((resolve) => {
    let settled = false;
    const timeout = setTimeout(
      () => settle({ status: "timed_out", timeoutMs }),
      timeoutMs,
    );
    timeout.unref?.();

    function cleanup(): void {
      clearTimeout(timeout);
      socket.off("message", handleMessage);
      socket.off("error", handleFailure);
      socket.off("close", handleFailure);
    }

    function settle(result: PairedSocketAcceptanceResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function handleFailure(): void {
      settle({ status: "closed" });
    }

    function handleMessage(data: WebSocket.RawData): void {
      const ready = parseListenerReadyMessage(data);
      if (!ready) return;
      if (
        ready.connection_generation !== identity.connectionGeneration ||
        ready.connection_attempt !== identity.connectionAttempt
      ) {
        settle({ status: "mismatched" });
        return;
      }
      settle({
        status: "accepted",
        connectionIncarnation: ready.connection_incarnation,
      });
    }

    socket.on("message", handleMessage);
    socket.once("error", handleFailure);
    socket.once("close", handleFailure);
  });
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

function rejectPairedSocketAcceptance(params: {
  channel: "control" | "stream";
  result: Exclude<PairedSocketAcceptanceResult, { status: "accepted" }>;
  trackListenerError: TrackListenerError;
}): void {
  const message =
    params.result.status === "timed_out"
      ? `${params.channel} WebSocket was not accepted within ${params.result.timeoutMs}ms`
      : params.result.status === "mismatched"
        ? `${params.channel} WebSocket received a mismatched listener_ready acknowledgement`
        : `${params.channel} WebSocket closed before listener_ready`;
  params.trackListenerError(
    `listener_${params.channel}_acceptance_${params.result.status}`,
    new Error(message),
    `listener_${params.channel}_acceptance`,
  );
  if (isDebugEnabled()) console.error(`[Listen] ${message}`);
}

export async function preparePairedListenerTransport(params: {
  runtime: ListenerRuntime;
  controlSocket: WebSocket;
  identity: ListenerPairIdentity;
  createStreamSocket: (connectionIncarnation?: string) => WebSocket;
  trackListenerError: TrackListenerError;
}): Promise<PairedListenerOpenOutcome> {
  const { runtime, controlSocket, identity, trackListenerError } = params;
  if (!isCurrentSocketPair(runtime, controlSocket, null)) {
    return { kind: "stale" };
  }

  const controlAcceptance = await waitForPairedSocketAcceptance(
    controlSocket,
    identity,
  );
  if (!isCurrentSocketPair(runtime, controlSocket, null)) {
    return { kind: "stale" };
  }
  if (controlAcceptance.status !== "accepted") {
    rejectPairedSocketAcceptance({
      channel: "control",
      result: controlAcceptance,
      trackListenerError,
    });
    terminateCurrentSocketPair(runtime, controlSocket, null);
    return { kind: "stale" };
  }

  const controlIncarnation = controlAcceptance.connectionIncarnation;
  const streamSocket = params.createStreamSocket(controlIncarnation);
  runtime.streamSocket = streamSocket;
  const streamAcceptance = await waitForPairedSocketAcceptance(
    streamSocket,
    identity,
  );
  if (!isCurrentSocketPair(runtime, controlSocket, streamSocket)) {
    return { kind: "stale" };
  }
  if (streamAcceptance.status !== "accepted") {
    rejectPairedSocketAcceptance({
      channel: "stream",
      result: streamAcceptance,
      trackListenerError,
    });
    terminateRejectedStreamPair(runtime, controlSocket, streamSocket);
    return { kind: "stale" };
  }
  if (streamAcceptance.connectionIncarnation !== controlIncarnation) {
    // Exactly one side carrying an incarnation is Cloud pod version skew in
    // either direction (no same-version affinity), not a stale pair. It stays
    // rejected but must not exhaust the startup budget.
    if (
      (controlIncarnation === undefined) !==
      (streamAcceptance.connectionIncarnation === undefined)
    ) {
      rolloutSkewRetries.add(runtime);
    }
    rejectPairedSocketAcceptance({
      channel: "stream",
      result: { status: "mismatched" },
      trackListenerError,
    });
    terminateRejectedStreamPair(runtime, controlSocket, streamSocket);
    return { kind: "stale" };
  }

  runtime.streamTransport = streamSocket;
  return { kind: "ready", transport: streamSocket, streamSocket };
}

export function attachSplitStreamSocketHandlers(params: {
  runtime: ListenerRuntime;
  streamSocket: WebSocket;
  trackListenerError: TrackListenerError;
}): void {
  params.streamSocket.on("error", (error: Error) => {
    params.trackListenerError(
      "listener_stream_socket_error",
      error,
      "listener_stream_socket",
    );
    if (isDebugEnabled())
      console.error("[Listen] Stream WebSocket error:", error);
  });
  params.streamSocket.on("close", (code: number, reason: Buffer) => {
    if (isDebugEnabled()) {
      console.log(
        `[Listen] Stream WebSocket closed (code: ${code}, reason: ${reason.toString()})`,
      );
    }
    terminateControlAfterStreamClose(
      params.runtime,
      params.streamSocket,
      code,
      reason,
    );
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
