import {
  createServer,
  type IncomingMessage as HttpIncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { getChannelRegistry } from "@/channels/registry";
import { stopScheduler as stopCronScheduler } from "@/cron/scheduler";
import type { DequeuedBatch } from "@/queue/queue-runtime";
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
import { AppServerConnectionRouter } from "@/websocket/app-server-connections";
import {
  handleOpenAiCompatRequest,
  isOpenAiCompatPath,
} from "@/websocket/app-server-openai";
import { closeOpenAiBridgeRuntime } from "@/websocket/app-server-openai-turn";
import { getAppServerInfoResponse } from "@/websocket/listener/commands/app-server-info";
import { attachListenerConnection } from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { installExternalToolBridge } from "@/websocket/listener/external-tools";
import {
  createRuntime,
  startConnectedListenerRuntime,
  stopRuntime,
} from "@/websocket/listener/lifecycle";
import { reloadListenerModAdapter } from "@/websocket/listener/mod-adapter";
import {
  getActiveRuntime,
  setActiveRuntime,
} from "@/websocket/listener/runtime";
import { handleIncomingMessage } from "@/websocket/listener/turn";
import type {
  IncomingMessage,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "@/websocket/listener/types";

const DEFAULT_LISTEN_URL = "ws://127.0.0.1:0";
const DEFAULT_WS_PATH = "/ws";
// App-server liveness watchdog. Here letta-code is the WS *server* (the client
// is the Desktop/relay), so we use protocol-level ws.ping()/pong rather than
// the app-level ping/pong the outbound listener uses. Ping every 30s and reap
// any client that has not ponged within 90s (3 missed pings). A half-open
// client connection (Desktop sleep, network switch, NAT idle timeout) never
// emits a `close` event, so the watchdog deterministically reclaims only that
// connection's scopes and leaves healthy clients untouched.
const APP_SERVER_HEARTBEAT_INTERVAL_MS = 30000;
const APP_SERVER_PONG_TIMEOUT_MS = 90000;

type AppServerConnectionMode = "duplex" | "legacy-stream";

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
  /** @internal Test hook for simulating a connection that stops answering pings. */
  shouldRecordPong?: (connectionOrdinal: number) => boolean;
}

export interface AppServerListeningInfo {
  url: string;
  duplexUrl: string;
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
  channel: "control" | "duplex" | "stream",
): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.searchParams.set("channel", channel);
  return url.toString();
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

function getRequestUrl(request: HttpIncomingMessage, host: string): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
}

function getRequestMode(url: URL): AppServerConnectionMode | null {
  const channel = url.searchParams.get("channel");
  if (
    channel === null ||
    channel === "" ||
    channel === "duplex" ||
    channel === "control"
  ) {
    return "duplex";
  }
  if (channel === "stream") {
    return "legacy-stream";
  }
  return null;
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
  const existingRuntime = getActiveRuntime();
  if (existingRuntime) {
    stopRuntime(existingRuntime, true);
  }
  const runtime = createRuntime();
  runtime.connectionId = `app-server-process-${crypto.randomUUID()}`;
  runtime.connectionName = options.connectionName ?? hostname();
  setActiveRuntime(runtime);
  telemetry.setSurface(getListenerTelemetrySurface());
  telemetry.init();

  const connectionRouter = new AppServerConnectionRouter(runtime);
  installExternalToolBridge(runtime);
  const processOptions: StartListenerOptions = {
    connectionId: runtime.connectionId,
    wsUrl: options.listen ?? DEFAULT_LISTEN_URL,
    deviceId: settingsManager.getOrCreateDeviceId(),
    connectionName: runtime.connectionName,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: (error) => {
      options.onLog?.(`App-server process runtime error: ${error.message}`);
    },
  };
  const processQueuedTurn: ProcessQueuedTurn = async (
    queuedTurn: IncomingMessage,
    dequeuedBatch: DequeuedBatch,
  ): Promise<void> => {
    const scopedRuntime = getOrCreateScopedRuntime(
      runtime,
      queuedTurn.agentId,
      queuedTurn.conversationId,
    );
    await handleIncomingMessage(
      queuedTurn,
      connectionRouter,
      scopedRuntime,
      processOptions.onStatusChange,
      processOptions.connectionId,
      dequeuedBatch.batchId,
    );
  };
  let processRuntimeStartup: Promise<void> | null = null;
  const ensureProcessRuntimeStarted = (): Promise<void> => {
    processRuntimeStartup ??= (async () => {
      await reloadListenerModAdapter(runtime);
      await loadTools();
      await startConnectedListenerRuntime(
        runtime,
        connectionRouter,
        processOptions,
        processQueuedTurn,
        { startHeartbeat: false, startCronScheduler: true },
      );
    })();
    return processRuntimeStartup;
  };

  // Tracks the last time each connected client responded to a ping. Seeded on
  // connection so a freshly-accepted socket gets a full grace window before the
  // watchdog can reap it. WeakMap so entries are GC'd with their sockets.
  const lastPongAtBySocket = new WeakMap<WebSocket, number>();
  let nextConnectionOrdinal = 0;

  const handleWebSocketConnection = (
    socket: WebSocket,
    mode: AppServerConnectionMode,
  ): void => {
    const connectionOrdinal = nextConnectionOrdinal;
    nextConnectionOrdinal += 1;
    lastPongAtBySocket.set(socket, Date.now());
    socket.on("pong", () => {
      if (options.shouldRecordPong?.(connectionOrdinal) === false) {
        return;
      }
      lastPongAtBySocket.set(socket, Date.now());
    });

    if (mode === "legacy-stream") {
      // Released split-channel clients still open this socket. It is an inert
      // compatibility companion: all frames now travel on control, so sockets
      // are never paired by arrival order and concurrent reconnects are safe.
      socket.on("error", (error) => {
        options.onLog?.(
          `App-server legacy stream socket error: ${error.message}`,
        );
      });
      return;
    }

    const connection = connectionRouter.add(socket);
    const startupReady = ensureProcessRuntimeStarted();
    void startupReady.catch((error) => {
      options.onLog?.(
        `Failed to initialize app-server process runtime: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1011, "failed to initialize app-server runtime");
      }
    });
    const connectionOptions: StartListenerOptions = {
      connectionId: connection.id,
      wsUrl: resolvedInfo?.duplexUrl ?? options.listen ?? DEFAULT_LISTEN_URL,
      deviceId: processOptions.deviceId,
      connectionName: processOptions.connectionName,
      onConnected: () => {},
      onDisconnected: () => {},
      onError: (error) => {
        options.onLog?.(
          `App-server connection ${connection.id} error: ${error.message}`,
        );
      },
    };
    attachListenerConnection(runtime, socket, connectionOptions, {
      startupReady,
      scopeHooks: {
        claim: (scope) => connectionRouter.claim(connection, scope),
        release: (scope) => connectionRouter.release(connection, scope),
        owns: (scope) => connectionRouter.owns(connection, scope),
      },
      onClosed: () => {
        connectionRouter.remove(connection);
      },
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
        startupReady: ensureProcessRuntimeStarted,
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

    const mode = getRequestMode(requestUrl);
    if (!mode) {
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
      handleWebSocketConnection(websocket, mode);
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
        // No pong within the timeout: reap only this half-open connection.
        // Other clients and the process runtime remain healthy.
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
    connectionRouter.close();
    stopRuntime(runtime, true);
    if (getActiveRuntime() === runtime) {
      setActiveRuntime(null);
    }
    throw error;
  }

  const address = getRequiredAddressInfo(server);
  const baseUrl = `ws://${listen.host}:${address.port}`;
  resolvedInfo = {
    url: baseUrl,
    duplexUrl: getChannelUrl(baseUrl, listen.path, "duplex"),
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
      connectionRouter.close();
      for (const client of wss.clients) {
        terminateSocket(client);
      }
      stopCronScheduler();
      getChannelRegistry()?.pause();
      stopRuntime(runtime, true);
      if (getActiveRuntime() === runtime) {
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
