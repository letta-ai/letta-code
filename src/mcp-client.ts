import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

export interface StdioMcpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

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

export interface ConnectStdioMcpServerOptions {
  clientInfo?: { name: string; version: string };
  stderr?: "inherit" | "pipe";
}

const DEFAULT_CLIENT_INFO = {
  name: "letta-code",
  version: "1",
};

/**
 * Start a stdio MCP server on the client machine and expose its tools through
 * a small transport-neutral interface suitable for SDK and channel adapters.
 */
export async function connectStdioMcpServer(
  config: StdioMcpServerConfig,
  options: ConnectStdioMcpServerOptions = {},
): Promise<ConnectedMcpServer> {
  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO);
  let connected = false;
  try {
    await client.connect(
      new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...getDefaultEnvironment(), ...config.env },
        ...(config.cwd ? { cwd: config.cwd } : {}),
        stderr: options.stderr ?? "inherit",
      }),
    );
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

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (isRecord(value) && value.type === "object") return value;
  return { type: "object", properties: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
