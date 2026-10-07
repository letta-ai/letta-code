import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  BROWSER_DEVICE_HANDOFF_SUBMIT_TIMEOUT_MS,
  type BrowserDeviceMcpOAuthRequest,
  canonicalizeBrowserDeviceMcpOAuthRequest,
  connectBrowserDeviceMcpOAuth,
} from "@/browser-device-mcp-oauth";

export const BROWSER_DISCOVERY_HOST = "127.0.0.1";
export const BROWSER_DISCOVERY_PORT = 8284;
export const BROWSER_DISCOVERY_PATH = "/status";
export const BROWSER_DEVICE_MCP_OAUTH_PATH = "/mcp-oauth/connect";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 280_000;
const HANDOFF_SUBMISSION_MARGIN_MS = 5_000;
const MAX_REQUEST_BODY_BYTES = 4_096;
const LOCAL_CONNECT_HEADER = "x-letta-local-connect";
const STATUS_BODY = JSON.stringify({ status: "ok" });
const LOCAL_BROWSER_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
const ALLOWED_BROWSER_ORIGINS = new Set(["https://chat.letta.com"]);

export interface BrowserDiscoveryServerAddress {
  host: string;
  port: number;
  url: string;
}

export interface BrowserDiscoveryServerHandle {
  ready: Promise<BrowserDiscoveryServerAddress>;
  close(): Promise<void>;
}

interface BrowserDiscoveryServerOptions {
  allowLocalBrowserOrigins?: boolean;
  connectMcpOAuth?: (
    request: BrowserDeviceMcpOAuthRequest,
    signal: AbortSignal,
    authorizationTimeoutMs: number,
  ) => Promise<void>;
  oauthTimeoutMs?: number;
  port?: number;
  retryDelayMs?: number;
}

/**
 * Start the browser discovery endpoint for this process.
 *
 * Multiple Letta Code processes can run on one device. The first process owns
 * the fixed discovery port; the others retry in the background so one of them
 * takes over after the owner exits. The server and retry timer are unref'd so
 * this best-effort endpoint never keeps a short-lived CLI command alive.
 */
export function startBrowserDiscoveryServer(
  options: BrowserDiscoveryServerOptions = {},
): BrowserDiscoveryServerHandle {
  const port = options.port ?? BROWSER_DISCOVERY_PORT;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const oauthTimeoutMs = options.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  const allowLocalBrowserOrigins =
    options.allowLocalBrowserOrigins ??
    process.env.LETTA_BROWSER_DEVICE_ALLOW_LOCAL_ORIGINS === "1";
  const connectMcpOAuth =
    options.connectMcpOAuth ??
    ((
      request: BrowserDeviceMcpOAuthRequest,
      signal: AbortSignal,
      authorizationTimeoutMs: number,
    ) =>
      connectBrowserDeviceMcpOAuth(
        request,
        undefined,
        signal,
        authorizationTimeoutMs,
      ));
  let activeServer: Server | null = null;
  let pendingServer: Server | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let readySettled = false;
  let resolveReady: (address: BrowserDiscoveryServerAddress) => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<BrowserDiscoveryServerAddress>(
    (resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    },
  );
  void ready.catch(() => undefined);

  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      attemptListen();
    }, retryDelayMs);
    retryTimer.unref();
  };

  const attemptListen = (): void => {
    if (stopped || activeServer || pendingServer) return;

    const candidate = createBrowserDiscoveryHttpServer(
      connectMcpOAuth,
      allowLocalBrowserOrigins,
      oauthTimeoutMs,
    );
    pendingServer = candidate;
    const onStartupError = (error: Error & { code?: string }): void => {
      pendingServer = null;
      candidate.close();
      if (error.code === "EADDRINUSE") {
        scheduleRetry();
        return;
      }
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
    };

    candidate.once("error", onStartupError);
    candidate.listen(port, BROWSER_DISCOVERY_HOST, () => {
      candidate.off("error", onStartupError);
      if (stopped) {
        candidate.close();
        return;
      }

      pendingServer = null;
      activeServer = candidate;
      candidate.unref();
      const address = candidate.address();
      if (!address || typeof address === "string") {
        candidate.close();
        return;
      }
      if (!readySettled) {
        readySettled = true;
        resolveReady(formatDiscoveryAddress(address));
      }

      candidate.on("error", () => {
        if (activeServer !== candidate) return;
        activeServer = null;
        candidate.close();
        scheduleRetry();
      });
      candidate.once("close", () => {
        if (activeServer === candidate) activeServer = null;
        scheduleRetry();
      });
    });
  };

  attemptListen();

  return {
    ready,
    close: async () => {
      if (stopped) return;
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (!readySettled) {
        readySettled = true;
        rejectReady(
          new Error("Browser discovery server stopped before listening"),
        );
      }

      const servers = [pendingServer, activeServer].filter(
        (server): server is Server => server !== null,
      );
      pendingServer = null;
      activeServer = null;
      await Promise.all(servers.map(closeServer));
    },
  };
}

function createBrowserDiscoveryHttpServer(
  connectMcpOAuth: (
    request: BrowserDeviceMcpOAuthRequest,
    signal: AbortSignal,
    authorizationTimeoutMs: number,
  ) => Promise<void>,
  allowLocalBrowserOrigins: boolean,
  oauthTimeoutMs: number,
): Server {
  const activeConnections = new Set<string>();
  let server: Server;
  server = createServer((request, response) => {
    void handleBrowserDiscoveryRequest(
      server,
      request,
      response,
      connectMcpOAuth,
      allowLocalBrowserOrigins,
      activeConnections,
      oauthTimeoutMs,
    );
  });
  server.on("connection", (socket) => socket.unref());
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  return server;
}

async function handleBrowserDiscoveryRequest(
  server: Server,
  request: IncomingMessage,
  response: ServerResponse,
  connectMcpOAuth: (
    request: BrowserDeviceMcpOAuthRequest,
    signal: AbortSignal,
    authorizationTimeoutMs: number,
  ) => Promise<void>,
  allowLocalBrowserOrigins: boolean,
  activeConnections: Set<string>,
  oauthTimeoutMs: number,
): Promise<void> {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    respond(response, 403, "Browser connection must use loopback");
    return;
  }
  const address = server.address();
  const expectedHost =
    address && typeof address !== "string"
      ? `${BROWSER_DISCOVERY_HOST}:${address.port}`
      : null;
  if (!expectedHost || request.headers.host !== expectedHost) {
    respond(response, 400, "Invalid discovery host");
    return;
  }
  if (
    request.url !== BROWSER_DISCOVERY_PATH &&
    request.url !== BROWSER_DEVICE_MCP_OAUTH_PATH
  ) {
    respond(response, 404, "Not found");
    return;
  }

  const origin = allowedBrowserOrigin(
    request.headers.origin,
    request.url === BROWSER_DISCOVERY_PATH || allowLocalBrowserOrigins,
  );
  if (request.method === "OPTIONS") {
    if (!origin) {
      respond(response, 403, "Browser origin is not allowed");
      return;
    }
    response.writeHead(204, {
      ...browserAccessHeaders(origin),
      "Content-Length": "0",
    });
    response.end();
    return;
  }
  if (request.url === BROWSER_DISCOVERY_PATH && request.method === "GET") {
    response.writeHead(200, {
      ...browserAccessHeaders(origin),
      "Content-Length": String(Buffer.byteLength(STATUS_BODY)),
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(STATUS_BODY);
    return;
  }
  if (
    request.url === BROWSER_DEVICE_MCP_OAUTH_PATH &&
    request.method === "POST"
  ) {
    if (!origin) {
      respond(response, 403, "Browser origin is not allowed");
      return;
    }
    await handleMcpOAuthConnectRequest(
      request,
      response,
      origin,
      connectMcpOAuth,
      activeConnections,
      oauthTimeoutMs,
    );
    return;
  }

  const allow =
    request.url === BROWSER_DEVICE_MCP_OAUTH_PATH
      ? "POST, OPTIONS"
      : "GET, OPTIONS";
  response.writeHead(405, {
    ...browserAccessHeaders(origin),
    Allow: allow,
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end("Method not allowed");
}

async function handleMcpOAuthConnectRequest(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  connectMcpOAuth: (
    request: BrowserDeviceMcpOAuthRequest,
    signal: AbortSignal,
    authorizationTimeoutMs: number,
  ) => Promise<void>,
  activeConnections: Set<string>,
  oauthTimeoutMs: number,
): Promise<void> {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    response.writeHead(415, {
      ...browserAccessHeaders(origin),
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Content-Type must be application/json");
    return;
  }
  if (request.headers[LOCAL_CONNECT_HEADER] !== "1") {
    respondJson(response, 400, { status: "invalid_request" }, origin);
    return;
  }
  request.socket.ref();
  const disconnectController = new AbortController();
  const abortForDisconnect = (): void => {
    if (response.writableEnded || disconnectController.signal.aborted) return;
    disconnectController.abort(
      new DOMException("Browser request disconnected", "AbortError"),
    );
  };
  request.once("aborted", abortForDisconnect);
  request.socket.once("close", abortForDisconnect);
  response.once("close", abortForDisconnect);
  const operationDeadlineAt = Date.now() + oauthTimeoutMs;
  const signal = AbortSignal.any([
    disconnectController.signal,
    AbortSignal.timeout(oauthTimeoutMs),
  ]);
  let connectionKey: string | undefined;
  try {
    if (
      request.aborted ||
      request.destroyed ||
      request.socket.destroyed ||
      response.destroyed
    ) {
      abortForDisconnect();
    }
    signal.throwIfAborted();
    const parsed = canonicalizeBrowserDeviceMcpOAuthRequest(
      parseMcpOAuthRequest(await readRequestBody(request, signal)),
    );
    signal.throwIfAborted();
    connectionKey = `${parsed.service}\0${parsed.serverUrl}`;
    if (activeConnections.has(connectionKey)) {
      respondJson(response, 409, { status: "already_connecting" }, origin);
      return;
    }
    activeConnections.add(connectionKey);
    try {
      const authorizationTimeoutMs =
        operationDeadlineAt -
        Date.now() -
        BROWSER_DEVICE_HANDOFF_SUBMIT_TIMEOUT_MS -
        HANDOFF_SUBMISSION_MARGIN_MS;
      if (authorizationTimeoutMs <= 0) {
        throw new DOMException(
          "Browser-device OAuth submission reserve was exhausted",
          "TimeoutError",
        );
      }
      await connectMcpOAuth(parsed, signal, authorizationTimeoutMs);
      respondJson(response, 200, { status: "connected" }, origin);
    } finally {
      activeConnections.delete(connectionKey);
    }
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof BrowserRequestError) {
      respondJson(
        response,
        error.status,
        { status: "invalid_request" },
        origin,
      );
      return;
    }
    if (
      error instanceof Error &&
      error.name === "BrowserDeviceMcpOAuthRequestError"
    ) {
      respondJson(response, 400, { status: "invalid_request" }, origin);
      return;
    }
    respondJson(response, 502, { status: "connection_failed" }, origin);
  } finally {
    request.off("aborted", abortForDisconnect);
    request.socket.off("close", abortForDisconnect);
    response.off("close", abortForDisconnect);
    request.socket.unref();
  }
}

function allowedBrowserOrigin(
  value: string | undefined,
  allowLocalBrowserOrigins: boolean,
): string | undefined {
  if (!value) return undefined;
  return ALLOWED_BROWSER_ORIGINS.has(value) ||
    (allowLocalBrowserOrigins && LOCAL_BROWSER_ORIGIN.test(value))
    ? value
    : undefined;
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::ffff:127.0.0.1";
}

function browserAccessHeaders(origin?: string): Record<string, string> {
  return {
    "Access-Control-Allow-Headers": "Content-Type, X-Letta-Local-Connect",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    Vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Method, Access-Control-Request-Private-Network",
  };
}

class BrowserRequestError extends Error {
  constructor(readonly status: number) {
    super("Invalid browser request");
  }
}

async function readRequestBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = Number(request.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_BODY_BYTES
  ) {
    request.resume();
    throw new BrowserRequestError(413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const abortBodyRead = (): void => {
    request.destroy(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Browser request timed out", "TimeoutError"),
    );
  };
  signal.addEventListener("abort", abortBodyRead, { once: true });
  try {
    signal.throwIfAborted();
    for await (const rawChunk of request) {
      signal.throwIfAborted();
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk as ArrayBuffer);
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        throw new BrowserRequestError(413);
      }
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abortBodyRead);
  }
}

function parseMcpOAuthRequest(value: string): BrowserDeviceMcpOAuthRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BrowserRequestError(400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BrowserRequestError(400);
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.handoffKey !== "string" ||
    typeof record.service !== "string" ||
    typeof record.serverUrl !== "string"
  ) {
    throw new BrowserRequestError(400);
  }
  return {
    handoffKey: record.handoffKey,
    service: record.service,
    serverUrl: record.serverUrl,
  };
}

function respondJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, string>,
  origin: string,
): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...browserAccessHeaders(origin),
    "Content-Length": String(Buffer.byteLength(serialized)),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(serialized);
}

function respond(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    "Content-Length": String(Buffer.byteLength(body)),
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

function formatDiscoveryAddress(
  address: AddressInfo,
): BrowserDiscoveryServerAddress {
  return {
    host: BROWSER_DISCOVERY_HOST,
    port: address.port,
    url: `http://${BROWSER_DISCOVERY_HOST}:${address.port}${BROWSER_DISCOVERY_PATH}`,
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) {
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        server.off("listening", onListening);
        server.off("close", settle);
        server.off("error", settle);
        resolve();
      };
      const onListening = (): void => {
        server.off("close", settle);
        server.off("error", settle);
        server.close(() => settle());
      };
      server.once("listening", onListening);
      server.once("close", settle);
      server.once("error", settle);
    });
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
