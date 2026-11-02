import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { getClient } from "./client";
import type { UnifiedMcpClient } from "./unified-mcp";

export const MCP_SUBPROCESS_BROKER_SOCKET_ENV =
  "LETTA_MCP_SUBPROCESS_BROKER_SOCKET";
export const MCP_SUBPROCESS_BROKER_KEY_ENV = "LETTA_MCP_SUBPROCESS_BROKER_KEY";

const MCP_ORIGINATOR_TOKEN_HEADER = "x-letta-mcp-originator-token";
const MCP_ORIGINATOR_ISOLATION_HEADER = "x-letta-mcp-originator-isolation";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const BROKER_PATH = "/mcp";
const TCP_RENDEZVOUS_PREFIX = "tcp-file:";

type BrokerRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
};

type BrokerResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

type McpBrokerScope = {
  agentId: string;
  originatorToken?: string;
};

type ParsedMcpRequest = {
  agentId: string;
  path: string;
};

type BrokerUpstreamClient = {
  get(
    path: string,
    options?: { headers?: Record<string, string> },
  ): Promise<unknown>;
  post(
    path: string,
    options?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<unknown>;
};

export interface McpSubprocessBroker {
  env: Record<string, string>;
  redactions: Record<string, string>;
  close(): void;
}

function socketPath(): string {
  const nonce = randomBytes(16).toString("hex");
  const extension = process.platform === "win32" ? "port" : "sock";
  return path.join(tmpdir(), `letta-mcp-${process.pid}-${nonce}.${extension}`);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function originatorHeaders(
  token: string | undefined,
): Record<string, string> | undefined {
  return token
    ? {
        [MCP_ORIGINATOR_TOKEN_HEADER]: token,
        [MCP_ORIGINATOR_ISOLATION_HEADER]: "1",
      }
    : undefined;
}

function decodeCanonicalSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      return null;
    }
    return encodeURIComponent(decoded) === segment ? decoded : null;
  } catch {
    return null;
  }
}

function parseMcpRequest(
  method: BrokerRequest["method"],
  requestPath: string,
): ParsedMcpRequest | null {
  if (requestPath.includes("?") || requestPath.includes("#")) return null;
  const parts = requestPath.split("/");
  if (
    parts[0] !== "" ||
    parts[1] !== "v1" ||
    parts[2] !== "agents" ||
    parts[4] !== "mcp-servers"
  ) {
    return null;
  }
  const agentId = parts[3] ? decodeCanonicalSegment(parts[3]) : null;
  if (!agentId) return null;

  if (method === "GET" && parts.length === 5) {
    return {
      agentId,
      path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers`,
    };
  }
  if (method === "GET" && parts.length === 7 && parts[6] === "tools") {
    const serverId = parts[5] ? decodeCanonicalSegment(parts[5]) : null;
    if (!serverId) return null;
    return {
      agentId,
      path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(serverId)}/tools`,
    };
  }
  if (
    method === "POST" &&
    parts.length === 7 &&
    parts[5] === "tools" &&
    parts[6] === "search"
  ) {
    return {
      agentId,
      path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/tools/search`,
    };
  }
  if (
    method === "POST" &&
    parts.length === 9 &&
    parts[6] === "tools" &&
    parts[8] === "run"
  ) {
    const serverId = parts[5] ? decodeCanonicalSegment(parts[5]) : null;
    const toolId = parts[7] ? decodeCanonicalSegment(parts[7]) : null;
    if (!serverId || !toolId) return null;
    return {
      agentId,
      path: `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolId)}/run`,
    };
  }
  return null;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: BrokerResponse,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Start a process-local MCP proxy for one shell execution context. The child
 * receives only an opaque local capability. The parent resolves the context's
 * current originator at request time and adds the bearer to the Cloud request;
 * raw bearer material never enters the child process.
 */
export function createMcpSubprocessBroker(options: {
  agentId: string;
  getAllowedAgentIds?: () => Promise<ReadonlySet<string>>;
  getScope: () => McpBrokerScope | null;
  getClient: () => Promise<BrokerUpstreamClient>;
}): McpSubprocessBroker {
  const socket = socketPath();
  const endpoint =
    process.platform === "win32" ? `${TCP_RENDEZVOUS_PREFIX}${socket}` : socket;
  const key = randomBytes(32).toString("hex");
  const connections = new Set<Socket>();
  let allowedAgentIds: Promise<ReadonlySet<string>> | undefined;
  const resolveAllowedAgentIds = () => {
    if (!allowedAgentIds) {
      allowedAgentIds = options.getAllowedAgentIds
        ? options.getAllowedAgentIds()
        : Promise.resolve(new Set([options.agentId]));
    }
    return allowedAgentIds;
  };
  let closed = false;
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== BROKER_PATH) {
          sendJson(response, 404, { ok: false, error: "Not found" });
          return;
        }
        const authorization = request.headers.authorization;
        if (
          typeof authorization !== "string" ||
          !authorization.startsWith("Bearer ") ||
          !safeEqual(authorization.slice("Bearer ".length), key)
        ) {
          sendJson(response, 403, { ok: false, error: "Forbidden" });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_REQUEST_BYTES) {
            sendJson(response, 413, {
              ok: false,
              error: "MCP broker request is too large",
            });
            request.destroy();
            return;
          }
          chunks.push(buffer);
        }

        let payload: BrokerRequest;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          sendJson(response, 400, {
            ok: false,
            error: "Invalid MCP broker request",
          });
          return;
        }
        if (
          (payload.method !== "GET" && payload.method !== "POST") ||
          typeof payload.path !== "string"
        ) {
          sendJson(response, 400, {
            ok: false,
            error: "Invalid MCP broker request",
          });
          return;
        }

        const parsed = parseMcpRequest(payload.method, payload.path);
        const [initialScope, allowedAgents] = await Promise.all([
          options.getScope(),
          resolveAllowedAgentIds(),
        ]);
        if (
          closed ||
          !parsed ||
          !initialScope ||
          initialScope.agentId !== options.agentId ||
          !allowedAgents.has(parsed.agentId)
        ) {
          sendJson(response, 403, { ok: false, error: "Forbidden" });
          return;
        }

        const client = await options.getClient();
        const scope = options.getScope();
        if (closed) {
          response.destroy();
          return;
        }
        if (!scope || scope.agentId !== options.agentId) {
          sendJson(response, 403, { ok: false, error: "Forbidden" });
          return;
        }
        // Discovery needs the same verified identity as execution so Cloud can
        // omit restricted servers and tools from unauthorized turns.
        const headers = originatorHeaders(scope.originatorToken);
        const value =
          payload.method === "GET"
            ? await client.get(parsed.path, ...(headers ? [{ headers }] : []))
            : await client.post(parsed.path, {
                ...(payload.body !== undefined ? { body: payload.body } : {}),
                ...(headers ? { headers } : {}),
              });
        sendJson(response, 200, { ok: true, value });
      })().catch(() => {
        if (closed) {
          response.destroy();
          return;
        }
        if (!response.headersSent) {
          sendJson(response, 500, {
            ok: false,
            error: "MCP broker request failed",
          });
        } else {
          response.destroy();
        }
      });
    },
  );

  server.on("error", () => {
    // The child receives a bounded connection error. Do not crash the host.
  });
  server.on("connection", (connection: Socket) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  });
  server.on("listening", () => {
    if (closed) {
      server.close();
      return;
    }
    if (process.platform === "win32") {
      const address = server.address();
      if (address && typeof address === "object") {
        try {
          writeFileSync(socket, String(address.port), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
        } catch {
          server.close();
        }
      }
    } else {
      try {
        chmodSync(socket, 0o600);
      } catch {
        // The random capability still protects the short-lived broker.
      }
    }
  });
  if (process.platform === "win32") {
    server.listen(0, "127.0.0.1");
  } else {
    server.listen(socket);
  }
  return {
    env: {
      [MCP_SUBPROCESS_BROKER_SOCKET_ENV]: endpoint,
      [MCP_SUBPROCESS_BROKER_KEY_ENV]: key,
    },
    redactions: {
      [MCP_SUBPROCESS_BROKER_SOCKET_ENV]: endpoint,
      [MCP_SUBPROCESS_BROKER_KEY_ENV]: key,
    },
    close() {
      if (closed) return;
      closed = true;
      for (const connection of connections) connection.destroy();
      connections.clear();
      try {
        server.close();
      } catch {
        // The child may exit before the asynchronous listen completes.
      }
      if (existsSync(socket)) {
        try {
          unlinkSync(socket);
        } catch {
          // Best-effort cleanup; the randomized path is never reused.
        }
      }
    },
  };
}

async function brokerRequestTarget(
  endpoint: string,
): Promise<{ socketPath: string } | { host: string; port: number }> {
  if (!endpoint.startsWith(TCP_RENDEZVOUS_PREFIX)) {
    return { socketPath: endpoint };
  }
  const rendezvousPath = endpoint.slice(TCP_RENDEZVOUS_PREFIX.length);
  const value = (await readFile(rendezvousPath, "utf8")).trim();
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw Object.assign(new Error("MCP broker is starting"), {
      code: "EAGAIN",
    });
  }
  return { host: "127.0.0.1", port };
}

async function requestBroker(
  endpoint: string,
  key: string,
  payload: BrokerRequest,
): Promise<unknown> {
  const body = JSON.stringify(payload);
  const target = await brokerRequestTarget(endpoint);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        ...target,
        path: BROKER_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("MCP broker response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          let parsed: BrokerResponse;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new Error("Invalid MCP broker response"));
            return;
          }
          if (!parsed.ok) {
            reject(new Error(parsed.error));
            return;
          }
          resolve(parsed.value);
        });
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("MCP broker aborted")));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function requestBrokerWithStartupRetry(
  endpoint: string,
  key: string,
  payload: BrokerRequest,
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await requestBroker(endpoint, key, payload);
    } catch (error) {
      lastError = error;
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT" && code !== "ECONNREFUSED" && code !== "EAGAIN") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

/** Return the parent-mediated MCP client available to a shell child. */
export function createMcpSubprocessBrokerClient(
  env: NodeJS.ProcessEnv,
): UnifiedMcpClient | null {
  const endpoint = env[MCP_SUBPROCESS_BROKER_SOCKET_ENV]?.trim();
  const key = env[MCP_SUBPROCESS_BROKER_KEY_ENV]?.trim();
  if (!endpoint || !key) return null;
  return {
    get: (requestPath) =>
      requestBrokerWithStartupRetry(endpoint, key, {
        method: "GET",
        path: requestPath,
      }),
    post: (requestPath, options) =>
      requestBrokerWithStartupRetry(endpoint, key, {
        method: "POST",
        path: requestPath,
        ...(options?.body !== undefined ? { body: options.body } : {}),
      }),
  };
}

/** Prefer the parent broker in a shell child; ordinary CLI calls use Cloud. */
export async function getMcpSubprocessBrokerClientOrDefault(
  env: NodeJS.ProcessEnv,
): Promise<UnifiedMcpClient> {
  return (
    createMcpSubprocessBrokerClient(env) ??
    ((await getClient()) as UnifiedMcpClient)
  );
}
