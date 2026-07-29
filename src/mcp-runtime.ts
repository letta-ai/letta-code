import {
  type ConnectedMcpServer,
  connectMcpServer,
  type McpServerConfig,
  type McpToolResult,
} from "@/mcp-client";
import {
  type ExternalToolDefinition,
  registerExternalTools,
  unregisterExternalTools,
} from "@/tools/manager";

export interface ClientMcpServerState {
  config: McpServerConfig;
  status: "connected" | "failed";
  tools: ExternalToolDefinition[];
  error?: string;
}

interface ActiveMcpServer {
  connection: ConnectedMcpServer;
  tools: ExternalToolDefinition[];
}

const CLIENT_MCP_RUNTIME_KEY = Symbol.for("@letta/clientMcpRuntime");

type ClientMcpRuntime = {
  active: Map<string, ActiveMcpServer>;
  states: ClientMcpServerState[];
};

type GlobalWithClientMcpRuntime = typeof globalThis & {
  [CLIENT_MCP_RUNTIME_KEY]?: ClientMcpRuntime;
};

function getRuntime(): ClientMcpRuntime {
  const global = globalThis as GlobalWithClientMcpRuntime;
  if (!global[CLIENT_MCP_RUNTIME_KEY]) {
    global[CLIENT_MCP_RUNTIME_KEY] = { active: new Map(), states: [] };
  }
  return global[CLIENT_MCP_RUNTIME_KEY];
}

/** Replace all client-local MCP connections and their model-facing tools. */
export async function replaceClientMcpServers(
  configs: readonly McpServerConfig[],
): Promise<ClientMcpServerState[]> {
  await closeClientMcpServers();
  const runtime = getRuntime();
  const usedToolNames = new Set<string>();
  const states = await Promise.all(
    configs.map(async (config): Promise<ClientMcpServerState> => {
      try {
        const connection = await connectMcpServer(config);
        const tools = connection.tools.map((tool) => {
          const name = uniqueToolName(
            `mcp__${normalizeName(config.name)}__${normalizeName(tool.name)}`,
            usedToolNames,
          );
          const definition: ExternalToolDefinition = {
            name,
            label: tool.title ?? tool.name,
            description:
              tool.description ??
              `Tool ${tool.name} from MCP server ${config.name}`,
            parameters: tool.inputSchema,
            executor: async (_toolCallId, _toolName, input) =>
              toExternalToolResult(await connection.callTool(tool.name, input)),
          };
          return definition;
        });
        registerExternalTools(tools);
        runtime.active.set(config.name, { connection, tools });
        return { config, status: "connected", tools };
      } catch (error) {
        return {
          config,
          status: "failed",
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  runtime.states = states;
  return states;
}

/** Current local MCP connection state for the /mcp manager. */
export function getClientMcpServerStates(): ClientMcpServerState[] {
  return [...getRuntime().states];
}

/** Close every local MCP connection and unregister its tools. */
export async function closeClientMcpServers(): Promise<void> {
  const runtime = getRuntime();
  const active = [...runtime.active.values()];
  runtime.active.clear();
  runtime.states = [];
  for (const server of active) {
    unregisterExternalTools(server.tools);
  }
  await Promise.allSettled(active.map((server) => server.connection.close()));
}

function uniqueToolName(base: string, used: Set<string>): string {
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base}_${suffix}`;
    suffix++;
  }
  used.add(name);
  return name;
}

function normalizeName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || "tool";
}

function toExternalToolResult(result: McpToolResult): {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError: boolean;
} {
  return {
    content: result.content.map((item) => normalizeContent(item)),
    isError: result.isError === true,
  };
}

function normalizeContent(item: unknown): {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
} {
  if (isRecord(item)) {
    if (item.type === "text" && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    if (
      (item.type === "image" || item.type === "audio") &&
      typeof item.data === "string"
    ) {
      return {
        type: item.type,
        data: item.data,
        ...(typeof item.mimeType === "string"
          ? { mimeType: item.mimeType }
          : {}),
      };
    }
  }
  return { type: "text", text: JSON.stringify(item) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
