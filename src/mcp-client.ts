import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

interface McpServerConfigBase {
  name: string;
}

export interface StdioMcpServerConfig extends McpServerConfigBase {
  transport?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpMcpServerConfig extends McpServerConfigBase {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface SseMcpServerConfig extends McpServerConfigBase {
  transport: "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig =
  | StdioMcpServerConfig
  | HttpMcpServerConfig
  | SseMcpServerConfig;

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  icons?: Array<Record<string, unknown>>;
}

export interface McpToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ConnectedMcpServer {
  name: string;
  tools: McpToolDefinition[];
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolResult>;
  close(): Promise<void>;
}

export interface McpOAuthConnection {
  authProvider: OAuthClientProvider;
  waitForAuthorizationCode?: () => Promise<string>;
  closeCallback?(): Promise<void>;
  close(): Promise<void>;
}

/** Package-owned structural fetch shape for MCP network requests. */
export type McpFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ConnectMcpServerOptions {
  clientInfo?: { name: string; version: string };
  /** Custom fetch used for MCP transport and every SDK OAuth request. */
  fetch?: McpFetch;
  stderr?: "inherit" | "pipe";
  oauth?: McpOAuthConnection;
  signal?: AbortSignal;
}

declare const LETTA_VERSION: string | undefined;

const DEFAULT_CLIENT_INFO = {
  name: "letta-code",
  version: typeof LETTA_VERSION === "undefined" ? "0" : LETTA_VERSION,
};

/**
 * Connect to an MCP server from the client process and expose its tools through
 * a small transport-neutral interface suitable for SDK and channel adapters.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  options: ConnectMcpServerOptions = {},
): Promise<ConnectedMcpServer> {
  let client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO);
  try {
    options.signal?.throwIfAborted();
    const transport = createTransport(config, options);
    try {
      await client.connect(
        transport,
        options.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      if (
        !(error instanceof UnauthorizedError) ||
        !options.oauth?.waitForAuthorizationCode ||
        !supportsOAuthCompletion(transport)
      ) {
        throw error;
      }
      const authorizationCode = await withAbort(
        options.oauth.waitForAuthorizationCode(),
        options.signal,
        () => options.oauth?.close(),
      );
      await withAbort(
        transport.finishAuth(authorizationCode),
        options.signal,
        () => transport.close(),
      );
      await client
        .close()
        .catch(() => transport.close().catch(() => undefined));
      client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO);
      await client.connect(
        createTransport(config, options),
        options.signal ? { signal: options.signal } : undefined,
      );
    }
    await (options.oauth?.closeCallback?.() ??
      options.oauth?.close() ??
      Promise.resolve());
    const response = await client.listTools(
      undefined,
      options.signal ? { signal: options.signal } : undefined,
    );
    const tools = response.tools.map((tool) => ({
      ...tool,
      inputSchema: normalizeInputSchema(tool.inputSchema),
      ...(tool.outputSchema
        ? { outputSchema: normalizeInputSchema(tool.outputSchema) }
        : {}),
    }));

    let closed = false;
    return {
      name: config.name,
      tools,
      callTool: async (name, args = {}, callOptions = {}) => {
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          callOptions.signal ? { signal: callOptions.signal } : undefined,
        );
        return {
          content: Array.isArray(result.content) ? result.content : [],
          ...(typeof result.isError === "boolean"
            ? { isError: result.isError }
            : {}),
          ...(isRecord(result.structuredContent)
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
        };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled([
          client.close(),
          options.oauth?.close(),
        ]);
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failure) throw failure.reason;
      },
    };
  } catch (error) {
    await options.oauth?.close();
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function withAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => Promise<unknown> | unknown,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void Promise.resolve(onAbort?.()).catch(() => undefined);
      reject(
        signal.reason ?? new DOMException("Operation aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Start a stdio MCP server on the client machine. */
export function connectStdioMcpServer(
  config: StdioMcpServerConfig,
  options: ConnectMcpServerOptions = {},
): Promise<ConnectedMcpServer> {
  return connectMcpServer({ ...config, transport: "stdio" }, options);
}

function createTransport(
  config: McpServerConfig,
  options: ConnectMcpServerOptions,
): Transport {
  if (config.transport === "http") {
    const headers = resolveHeaderEnvironment(config.headers);
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headersRequestInit(headers),
      authProvider: options.oauth?.authProvider,
      fetch: abortAwareFetch(options.signal, undefined, options.fetch),
    });
  }
  if (config.transport === "sse") {
    const headers = resolveHeaderEnvironment(config.headers);
    const requestInit = headersRequestInit(headers);
    return new SSEClientTransport(new URL(config.url), {
      requestInit,
      authProvider: options.oauth?.authProvider,
      fetch: abortAwareFetch(options.signal, headers, options.fetch),
    });
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...getDefaultEnvironment(), ...config.env },
    ...(config.cwd ? { cwd: config.cwd } : {}),
    stderr: options.stderr ?? "inherit",
  });
}

function abortAwareFetch(
  operationSignal?: AbortSignal,
  headers?: Record<string, string>,
  fetchFn?: McpFetch,
): McpFetch | undefined {
  if (!operationSignal && !headers) return fetchFn;
  const request = fetchFn ?? fetch;
  return (url, init) => {
    const requestInit = headers ? mergeHeaders(init, headers) : { ...init };
    const requestSignal = requestInit.signal ?? undefined;
    return request(url, {
      ...requestInit,
      signal:
        operationSignal && requestSignal
          ? AbortSignal.any([operationSignal, requestSignal])
          : (operationSignal ?? requestSignal),
    });
  };
}

function supportsOAuthCompletion(
  transport: Transport,
): transport is Transport & { finishAuth(code: string): Promise<void> } {
  return (
    "finishAuth" in transport && typeof transport.finishAuth === "function"
  );
}

function resolveHeaderEnvironment(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, envName: string) => {
        const resolved = process.env[envName];
        if (resolved === undefined) {
          throw new Error(
            `MCP header ${name} references missing environment variable ${envName}`,
          );
        }
        return resolved;
      }),
    ]),
  );
}

function headersRequestInit(headers?: Record<string, string>): RequestInit {
  return headers ? { headers } : {};
}

function mergeHeaders(
  init: RequestInit | undefined,
  headers: Record<string, string>,
): RequestInit {
  return {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init?.headers).entries()),
      ...headers,
    },
  };
}

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (isRecord(value) && value.type === "object") return value;
  return { type: "object", properties: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
