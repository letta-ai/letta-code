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
}

export interface McpToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
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

export interface ConnectMcpServerOptions {
  clientInfo?: { name: string; version: string };
  stderr?: "inherit" | "pipe";
}

const DEFAULT_CLIENT_INFO = {
  name: "letta-code",
  version: "1",
};

/**
 * Connect to an MCP server from the client process and expose its tools through
 * a small transport-neutral interface suitable for SDK and channel adapters.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  options: ConnectMcpServerOptions = {},
): Promise<ConnectedMcpServer> {
  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO);
  let connected = false;
  try {
    await client.connect(createTransport(config, options));
    connected = true;
    const response = await client.listTools();
    const tools = response.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: normalizeInputSchema(tool.inputSchema),
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
          ...(result.isError === true ? { isError: true } : {}),
          ...(isRecord(result.structuredContent)
            ? { structuredContent: result.structuredContent }
            : {}),
        };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await client.close();
      },
    };
  } catch (error) {
    if (connected) {
      await client.close().catch(() => undefined);
    }
    throw error;
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
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: headersRequestInit(config.headers),
    });
  }
  if (config.transport === "sse") {
    const headers = config.headers;
    const requestInit = headersRequestInit(headers);
    return new SSEClientTransport(new URL(config.url), {
      requestInit,
      eventSourceInit: headers
        ? { fetch: (url, init) => fetch(url, mergeHeaders(init, headers)) }
        : undefined,
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
