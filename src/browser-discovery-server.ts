import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export const BROWSER_DISCOVERY_HOST = "127.0.0.1";
export const BROWSER_DISCOVERY_PORT = 8284;
export const BROWSER_DISCOVERY_PATH = "/status";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const STATUS_BODY = JSON.stringify({ status: "ok" });

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

    const candidate = createBrowserDiscoveryHttpServer();
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

function createBrowserDiscoveryHttpServer(): Server {
  let server: Server;
  server = createServer((request, response) => {
    handleBrowserDiscoveryRequest(server, request, response);
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  return server;
}

function handleBrowserDiscoveryRequest(
  server: Server,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const address = server.address();
  const expectedHost =
    address && typeof address !== "string"
      ? `${BROWSER_DISCOVERY_HOST}:${address.port}`
      : null;
  if (!expectedHost || request.headers.host !== expectedHost) {
    respond(response, 400, "Invalid discovery host");
    return;
  }
  if (request.url !== BROWSER_DISCOVERY_PATH) {
    respond(response, 404, "Not found");
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...browserAccessHeaders(),
      "Content-Length": "0",
    });
    response.end();
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, {
      ...browserAccessHeaders(),
      Allow: "GET, OPTIONS",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Method not allowed");
    return;
  }

  response.writeHead(200, {
    ...browserAccessHeaders(),
    "Content-Length": String(Buffer.byteLength(STATUS_BODY)),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(STATUS_BODY);
}

function browserAccessHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Private-Network",
  };
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
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
