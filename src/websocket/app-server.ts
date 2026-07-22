import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { settingsManager } from "@/settings-manager";
import { getListenerTelemetrySurface, telemetry } from "@/telemetry";
import { loadTools } from "@/tools/manager";
import {
  type AppServerWebsocketAuthSettings,
  authorizeUpgrade,
  isUnauthenticatedNonLoopbackListener,
  normalizeListenHost,
  policyFromSettings,
} from "@/websocket/app-server-auth";
import {
  handleOpenAiCompatRequest,
  isOpenAiCompatPath,
} from "@/websocket/app-server-openai";
import { closeOpenAiBridgeRuntime } from "@/websocket/app-server-openai-turn";
import {
  attachOpenListenerSocket,
  createRuntime,
  stopRuntime,
} from "@/websocket/listener/lifecycle";
import { reloadListenerModAdapter } from "@/websocket/listener/mod-adapter";
import {
  getActiveRuntime,
  setActiveRuntime,
} from "@/websocket/listener/runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";

const DEFAULT_LISTEN_URL = "ws://127.0.0.1:0";
const DEFAULT_WS_PATH = "/ws";
const PENDING_STREAM_TIMEOUT_MS = 5000;
// App-server liveness watchdog. Here letta-code is the WS *server* (the client
// is the Desktop/relay), so we use protocol-level ws.ping()/pong rather than
// the app-level ping/pong the outbound listener uses. Ping every 30s and reap
// any client that has not ponged within 90s (3 missed pings). A half-open
// client connection (Desktop sleep, network switch, NAT idle timeout) never
// emits a `close` event, which would otherwise wedge the single-occupancy
// control channel: new control connections are rejected with 1008 while the
// zombie session still holds `activeSession`. Terminating the dead socket
// fires its `close` handler, clears `activeSession`, and frees the channel for
// a reconnecting client.
const APP_SERVER_HEARTBEAT_INTERVAL_MS = 30000;
const APP_SERVER_PONG_TIMEOUT_MS = 90000;

type AppServerChannel = "control" | "stream";

export interface StartAppServerOptions {
  listen?: string;
  websocketAuth?: AppServerWebsocketAuthSettings;
  connectionName?: string;
  /** Serve OpenAI-compatible /v1/models and /v1/chat/completions routes. */
  openaiApi?: boolean;
  onListening?: (info: AppServerListeningInfo) => void;
  onLog?: (message: string) => void;
  /** @internal Test override for the liveness ping cadence (ms). */
  heartbeatIntervalMs?: number;
  /** @internal Test override for the pong timeout before a socket is reaped (ms). */
  pongTimeoutMs?: number;
}

export interface AppServerListeningInfo {
  url: string;
  controlUrl: string;
  streamUrl: string;
}

export interface AppServerHandle extends AppServerListeningInfo {
  close: () => Promise<void>;
}

export interface ParsedAppServerListenUrl {
  host: string;
  port: number;
  path: string;
}

type ActiveAppServerSession = {
  runtime: ListenerRuntime;
  controlSocket: WebSocket;
  streamSocket: WebSocket | null;
};

function getRequiredAddressInfo(server: Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve app-server listen address");
  }
  return address;
}

function getChannelUrl(
  baseUrl: string,
  path: string,
  channel: AppServerChannel,
): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.searchParams.set("channel", channel);
  return url.toString();
}

function closeSocket(
  socket: WebSocket | null,
  code = 1001,
  reason = "closing",
): void {
  if (!socket) return;
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close(code, reason);
  }
}

function terminateSocket(socket: WebSocket | null): void {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  socket.terminate();
}

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  message: string,
): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function getRequestUrl(request: IncomingMessage, host: string): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
}

function getRequestChannel(url: URL): AppServerChannel | null {
  const channel = url.searchParams.get("channel");
  if (channel === null || channel === "" || channel === "control") {
    return "control";
  }
  if (channel === "stream") {
    return "stream";
  }
  return null;
}

function attachStreamSocket(
  activeSession: ActiveAppServerSession,
  socket: WebSocket,
): void {
  if (activeSession.streamSocket) {
    closeSocket(socket, 1008, "stream channel already connected");
    return;
  }
  activeSession.streamSocket = socket;
  activeSession.runtime.streamSocket = socket;
  activeSession.runtime.streamTransport = socket;
  socket.on("close", () => {
    if (activeSession.streamSocket === socket) {
      activeSession.streamSocket = null;
    }
    if (activeSession.runtime.streamSocket === socket) {
      activeSession.runtime.streamSocket = null;
      activeSession.runtime.streamTransport = null;
    }
  });
}

export function parseAppServerListenUrl(
  listen: string = DEFAULT_LISTEN_URL,
): ParsedAppServerListenUrl {
  let url: URL;
  try {
    url = new URL(listen);
  } catch {
    throw new Error(`Invalid app-server listen URL: ${listen}`);
  }

  if (url.protocol !== "ws:") {
    throw new Error("app-server MVP only supports ws:// listen URLs");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "app-server listen URL cannot include auth, query, or hash",
    );
  }

  const port = url.port ? Number(url.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("app-server listen URL must include a valid port");
  }

  const path = url.pathname === "/" ? DEFAULT_WS_PATH : url.pathname;
  return { host: normalizeListenHost(url.hostname), port, path };
}

async function startControlSession(params: {
  socket: WebSocket;
  streamSocket: WebSocket | null;
  connectionName: string;
  serverUrl: string;
  onSessionCreated: (session: ActiveAppServerSession) => void;
  onSessionClosed: () => void;
}): Promise<ActiveAppServerSession> {
  const existingRuntime = getActiveRuntime();
  if (existingRuntime) {
    stopRuntime(existingRuntime, true);
    setActiveRuntime(null);
  }

  const runtime = createRuntime();
  runtime.onWsEvent = undefined;
  runtime.connectionId = `app-server-${crypto.randomUUID()}`;
  runtime.connectionName = params.connectionName;
  setActiveRuntime(runtime);
  telemetry.setSurface(getListenerTelemetrySurface());
  telemetry.init();

  const startupReady = (async () => {
    await reloadListenerModAdapter(runtime);
    await loadTools();
  })();

  const activeSession: ActiveAppServerSession = {
    runtime,
    controlSocket: params.socket,
    streamSocket: params.streamSocket,
  };
  params.onSessionCreated(activeSession);

  await attachOpenListenerSocket(
    runtime,
    params.socket,
    {
      connectionId: runtime.connectionId ?? "app-server",
      wsUrl: params.serverUrl,
      supportsSplitStatusChannels: true,
      deviceId: settingsManager.getOrCreateDeviceId(),
      connectionName: params.connectionName,
      onConnected: () => {},
      onDisconnected: params.onSessionClosed,
      onError: () => {},
    },
    {
      streamSocket: params.streamSocket,
      startHeartbeat: false,
      startCronScheduler: true,
      startupReady,
    },
  );

  return activeSession;
}

export async function startAppServer(
  options: StartAppServerOptions = {},
): Promise<AppServerHandle> {
  await settingsManager.initialize();

  const listen = parseAppServerListenUrl(options.listen);
  const authPolicy = await policyFromSettings(options.websocketAuth);
  if (isUnauthenticatedNonLoopbackListener(listen.host, authPolicy)) {
    throw new Error(
      `refusing to start non-loopback websocket listener ${listen.host}:${listen.port} without auth; configure \`--ws-auth capability-token\` or \`--ws-auth signed-bearer-token\``,
    );
  }
  const wss = new WebSocketServer({ noServer: true });
  let activeSession: ActiveAppServerSession | null = null;
  let pendingStreamSocket: WebSocket | null = null;
  let pendingStreamTimeout: ReturnType<typeof setTimeout> | null = null;
  let resolvedInfo: AppServerListeningInfo | null = null;
  // Tracks the last time each connected client responded to a ping. Seeded on
  // connection so a freshly-accepted socket gets a full grace window before the
  // watchdog can reap it. WeakMap so entries are GC'd with their sockets.
  const lastPongAtBySocket = new WeakMap<WebSocket, number>();

  const clearPendingStream = (): WebSocket | null => {
    if (pendingStreamTimeout) {
      clearTimeout(pendingStreamTimeout);
      pendingStreamTimeout = null;
    }
    const socket = pendingStreamSocket;
    pendingStreamSocket = null;
    return socket;
  };

  const handleWebSocketConnection = (
    socket: WebSocket,
    channel: AppServerChannel,
  ): void => {
    // Liveness tracking for the heartbeat watchdog. Applies to both control
    // and stream sockets. The `ws` library auto-replies to ping frames with a
    // pong, so any client whose TCP is still alive refreshes this timestamp.
    lastPongAtBySocket.set(socket, Date.now());
    socket.on("pong", () => {
      lastPongAtBySocket.set(socket, Date.now());
    });

    if (channel === "stream") {
      if (activeSession) {
        attachStreamSocket(activeSession, socket);
        return;
      }
      if (pendingStreamSocket) {
        closeSocket(socket, 1008, "stream channel already pending");
        return;
      }
      pendingStreamSocket = socket;
      pendingStreamTimeout = setTimeout(() => {
        const staleSocket = clearPendingStream();
        closeSocket(staleSocket, 1008, "control channel did not connect");
      }, PENDING_STREAM_TIMEOUT_MS);
      socket.on("close", () => {
        if (pendingStreamSocket === socket) {
          clearPendingStream();
        }
      });
      socket.on("error", (error) => {
        options.onLog?.(`App-server stream socket error: ${error.message}`);
      });
      return;
    }

    if (activeSession) {
      closeSocket(socket, 1008, "control channel already connected");
      return;
    }

    const streamSocket = clearPendingStream();
    void startControlSession({
      socket,
      streamSocket,
      connectionName: options.connectionName ?? hostname(),
      serverUrl: resolvedInfo?.url ?? options.listen ?? DEFAULT_LISTEN_URL,
      onSessionCreated: (session) => {
        activeSession = session;
      },
      onSessionClosed: () => {
        activeSession = null;
      },
    }).catch((error) => {
      if (activeSession?.controlSocket === socket) {
        activeSession = null;
      }
      options.onLog?.(
        `Failed to start app-server session: ${error instanceof Error ? error.message : String(error)}`,
      );
      closeSocket(socket, 1011, "failed to start session");
      closeSocket(streamSocket, 1011, "failed to start session");
    });
  };

  const server = createServer((request, response) => {
    const requestUrl = getRequestUrl(request, listen.host);
    if (request.headers.origin) {
      options.onLog?.(
        `Rejecting app-server request with Origin header: ${request.url ?? "/"}`,
      );
      response.writeHead(403);
      response.end();
      return;
    }

    if (requestUrl.pathname === "/readyz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }
    if (requestUrl.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok\n");
      return;
    }
    if (options.openaiApi && isOpenAiCompatPath(requestUrl.pathname)) {
      void handleOpenAiCompatRequest(request, response, {
        authPolicy,
        onLog: options.onLog,
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = getRequestUrl(request, listen.host);
    if (request.headers.origin) {
      options.onLog?.(
        `Rejecting app-server websocket request with Origin header: ${request.url ?? "/"}`,
      );
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    if (requestUrl.pathname !== listen.path && requestUrl.pathname !== "/") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const channel = getRequestChannel(requestUrl);
    if (!channel) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }

    const authError = authorizeUpgrade(request.headers, authPolicy);
    if (authError) {
      options.onLog?.(
        `Rejecting app-server websocket client: ${authError.message}`,
      );
      rejectUpgrade(socket, authError.statusCode, authError.message);
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      handleWebSocketConnection(websocket, channel);
    });
  });

  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? APP_SERVER_HEARTBEAT_INTERVAL_MS;
  const pongTimeoutMs = options.pongTimeoutMs ?? APP_SERVER_PONG_TIMEOUT_MS;
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const lastPongAt = lastPongAtBySocket.get(client) ?? now;
      if (now - lastPongAt > pongTimeoutMs) {
        // No pong within the timeout: the socket is half-open. Terminating it
        // fires the `close` handler that clears activeSession and frees the
        // control channel for a reconnecting client.
        options.onLog?.(
          `App-server terminating unresponsive socket (no pong in ${pongTimeoutMs}ms)`,
        );
        client.terminate();
        continue;
      }
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, heartbeatIntervalMs);
  // Do not let the watchdog keep the event loop alive on its own.
  heartbeatInterval.unref?.();
  wss.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listen.port, listen.host);
  });

  const address = getRequiredAddressInfo(server);
  const baseUrl = `ws://${listen.host}:${address.port}`;
  resolvedInfo = {
    url: baseUrl,
    controlUrl: getChannelUrl(baseUrl, listen.path, "control"),
    streamUrl: getChannelUrl(baseUrl, listen.path, "stream"),
  };
  options.onListening?.(resolvedInfo);

  return {
    ...resolvedInfo,
    close: async () => {
      clearInterval(heartbeatInterval);
      if (options.openaiApi) {
        closeOpenAiBridgeRuntime();
      }
      const streamSocket = clearPendingStream();
      terminateSocket(streamSocket);
      if (activeSession) {
        const session = activeSession;
        activeSession = null;
        terminateSocket(session.streamSocket);
        terminateSocket(session.controlSocket);
        stopRuntime(session.runtime, true);
        if (getActiveRuntime() === session.runtime) {
          setActiveRuntime(null);
        }
      }
      for (const client of wss.clients) {
        terminateSocket(client);
      }
      await new Promise<void>((resolve, reject) => {
        wss.close();
        const timeout = setTimeout(resolve, 1000);
        server.close((serverError) => {
          clearTimeout(timeout);
          if (serverError) {
            reject(serverError);
            return;
          }
          resolve();
        });
      });
    },
  };
}
