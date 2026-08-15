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
import { getAppServerInfoResponse } from "@/websocket/listener/commands/app-server-info";
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
// App-server liveness watchdog. Here letta-code is the WS *server* (the client
// is the Desktop/relay), so we use protocol-level ws.ping()/pong rather than
// the app-level ping/pong the outbound listener uses. Ping every 30s and reap
// any client that has not ponged within 90s (3 missed pings). A half-open
// client connection (Desktop sleep, network switch, NAT idle timeout) never
// emits a `close` event. Terminating the dead socket fires its connection-
// scoped cleanup without disturbing healthy peers.
const APP_SERVER_HEARTBEAT_INTERVAL_MS = 30000;
const APP_SERVER_PONG_TIMEOUT_MS = 90000;

export interface StartAppServerOptions {
  listen?: string;
  /**
   * Attach the server to an already-running listener runtime. The caller
   * retains ownership of that runtime; closing the server only detaches its
   * client sockets.
   */
  runtime?: ListenerRuntime;
  websocketAuth?: AppServerWebsocketAuthSettings;
  connectionName?: string;
  /** Serve OpenAI-compatible models, Chat Completions, and Responses routes. */
  openaiApi?: boolean;
  onListening?: (info: AppServerListeningInfo) => void;
  onLog?: (message: string) => void;
  /** @internal Test override for the liveness ping cadence (ms). */
  heartbeatIntervalMs?: number;
  /** @internal Test override for the pong timeout before a socket is reaped (ms). */
  pongTimeoutMs?: number;
  /** @internal Test hook for simulating one half-open client. */
  shouldRecordPong?: (connectionId: string) => boolean;
  /** @internal Test override for listener runtime initialization. */
  initializeRuntime?: (runtime: ListenerRuntime) => Promise<void>;
  /** Whether attached clients may start process-owned services. Defaults true. */
  startProcessServices?: boolean;
}

export interface AppServerListeningInfo {
  url: string;
  controlUrl: string;
}

export interface AppServerHandle extends AppServerListeningInfo {
  close: () => Promise<void>;
}

export interface ParsedAppServerListenUrl {
  host: string;
  port: number;
  path: string;
}

function getRequiredAddressInfo(server: Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve app-server listen address");
  }
  return address;
}

function getWebSocketUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = path;
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
  let resolvedInfo: AppServerListeningInfo | null = null;
  let nextConnectionOrdinal = 0;
  const runtime = options.runtime ?? createRuntime();
  const ownsRuntime = options.runtime === undefined;
  if (ownsRuntime) {
    runtime.onWsEvent = undefined;
    runtime.connectionId = "app-server";
    runtime.connectionName = options.connectionName ?? hostname();
  }
  let startupReady: Promise<void> | null = null;
  const getStartupReady = (): Promise<void> => {
    if (!ownsRuntime) {
      return Promise.resolve();
    }
    if (startupReady) {
      return startupReady;
    }
    const attempt = (async () => {
      if (options.initializeRuntime) {
        await options.initializeRuntime(runtime);
        return;
      }
      await reloadListenerModAdapter(runtime);
      await loadTools();
    })();
    startupReady = attempt;
    void attempt.catch(() => {
      if (startupReady === attempt) {
        startupReady = null;
      }
    });
    return startupReady;
  };
  // Tracks the last time each connected client responded to a ping. Seeded on
  // connection so a freshly-accepted socket gets a full grace window before the
  // watchdog can reap it. WeakMap so entries are GC'd with their sockets.
  const lastPongAtBySocket = new WeakMap<WebSocket, number>();

  const handleWebSocketConnection = (socket: WebSocket): void => {
    const connectionId = `app-server-${nextConnectionOrdinal}`;
    nextConnectionOrdinal += 1;
    // The `ws` library auto-replies to ping frames with a pong, so any client
    // whose TCP is still alive refreshes this connection-scoped timestamp.
    lastPongAtBySocket.set(socket, Date.now());
    socket.on("pong", () => {
      if (options.shouldRecordPong?.(connectionId) !== false) {
        lastPongAtBySocket.set(socket, Date.now());
      }
    });

    void attachOpenListenerSocket(
      runtime,
      socket,
      {
        connectionId,
        wsUrl: resolvedInfo?.url ?? options.listen ?? DEFAULT_LISTEN_URL,
        deviceId: settingsManager.getOrCreateDeviceId(),
        connectionName: options.connectionName ?? hostname(),
        onConnected: () => {},
        onDisconnected: () => {},
        onError: (error) => {
          options.onLog?.(
            `App-server connection ${connectionId} failed: ${error.message}`,
          );
        },
      },
      {
        startHeartbeat: false,
        startCronScheduler: true,
        startProcessServices: options.startProcessServices ?? true,
        startupReady: getStartupReady(),
      },
    ).catch((error) => {
      options.onLog?.(
        `Failed to start app-server connection: ${error instanceof Error ? error.message : String(error)}`,
      );
      closeSocket(socket, 1011, "failed to start connection");
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
    if (requestUrl.pathname === "/app-server-info") {
      const authError = authorizeUpgrade(request.headers, authPolicy);
      if (authError) {
        response.writeHead(authError.statusCode, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: authError.message }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      // Keep capability discovery identical across HTTP and WebSocket; HTTP
      // transport owns correlation, so this request id is only a shape marker.
      response.end(JSON.stringify(getAppServerInfoResponse("http-info")));
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
    if (requestUrl.pathname !== listen.path && requestUrl.pathname !== "/") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    if (requestUrl.searchParams.has("channel")) {
      options.onLog?.(
        "Rejecting legacy split-channel app-server client; upgrade to a one-socket client",
      );
      rejectUpgrade(socket, 426, "Upgrade Required");
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

    // Browser WebSocket APIs cannot set Authorization headers, while native
    // clients such as React Native may send both Authorization and Origin.
    // authorizeUpgrade() also returns null when auth is disabled, so require
    // an actual configured policy before treating the request as authenticated.
    if (request.headers.origin !== undefined && authPolicy.mode === undefined) {
      options.onLog?.(
        `Rejecting unauthenticated app-server websocket request with Origin header: ${request.url ?? "/"}; native clients such as React Native must configure --ws-auth capability-token or --ws-auth signed-bearer-token`,
      );
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      handleWebSocketConnection(websocket);
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

  try {
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
  } catch (error) {
    clearInterval(heartbeatInterval);
    if (ownsRuntime) runtime.intentionallyClosed = true;
    throw error;
  }

  if (ownsRuntime) {
    const existingRuntime = getActiveRuntime();
    if (existingRuntime) {
      stopRuntime(existingRuntime, true);
      setActiveRuntime(null);
    }
    setActiveRuntime(runtime);
  } else if (getActiveRuntime() !== runtime) {
    clearInterval(heartbeatInterval);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(
      "Shared app-server runtime must be the active listener runtime",
    );
  }
  if (ownsRuntime) {
    telemetry.setSurface(getListenerTelemetrySurface());
    telemetry.init();
  }

  const address = getRequiredAddressInfo(server);
  const baseUrl = `ws://${listen.host}:${address.port}`;
  resolvedInfo = {
    url: baseUrl,
    controlUrl: getWebSocketUrl(baseUrl, listen.path),
  };
  options.onListening?.(resolvedInfo);

  return {
    ...resolvedInfo,
    close: async () => {
      clearInterval(heartbeatInterval);
      if (options.openaiApi) {
        closeOpenAiBridgeRuntime();
      }
      for (const client of wss.clients) {
        terminateSocket(client);
      }
      if (ownsRuntime && getActiveRuntime() === runtime) {
        stopRuntime(runtime, true);
        setActiveRuntime(null);
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
