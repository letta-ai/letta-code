import {
  type ConnectedMcpServer,
  connectMcpServer,
  type McpOAuthConnection,
  type McpServerConfig,
  type McpToolResult,
} from "@/mcp-client";
import { createMcpOAuthSession } from "@/mcp-oauth";
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

export interface ReplaceClientMcpServersOptions {
  interactiveOAuth?: boolean;
  onStatus?: (message: string) => void;
  stderr?: "inherit" | "pipe";
}

const CLIENT_MCP_RUNTIME_KEY = Symbol.for("@letta/clientMcpRuntime");

type ClientMcpRuntime = {
  active: Map<string, ActiveMcpServer>;
  pendingOAuth: Set<McpOAuthConnection>;
  agentId: string | null;
  states: ClientMcpServerState[];
  generation: number;
};

type GlobalWithClientMcpRuntime = typeof globalThis & {
  [CLIENT_MCP_RUNTIME_KEY]?: ClientMcpRuntime;
};

function getRuntime(): ClientMcpRuntime {
  const global = globalThis as GlobalWithClientMcpRuntime;
  if (!global[CLIENT_MCP_RUNTIME_KEY]) {
    global[CLIENT_MCP_RUNTIME_KEY] = {
      active: new Map(),
      pendingOAuth: new Set(),
      agentId: null,
      states: [],
      generation: 0,
    };
  }
  const runtime = global[CLIENT_MCP_RUNTIME_KEY];
  if (!runtime.pendingOAuth) runtime.pendingOAuth = new Set();
  return runtime;
}

/** Replace all client-local MCP connections and their model-facing tools. */
export async function replaceClientMcpServers(
  agentId: string,
  configs: readonly McpServerConfig[],
  options: ReplaceClientMcpServersOptions = {},
): Promise<ClientMcpServerState[]> {
  const runtime = getRuntime();
  const generation = ++runtime.generation;
  await closeActiveServers(runtime);
  runtime.agentId = agentId;
  const usedToolNames = new Set<string>();
  const states = await Promise.all(
    configs.map(async (config): Promise<ClientMcpServerState> => {
      let oauth: McpOAuthConnection | undefined;
      try {
        oauth = await oauthSessionForConfig(agentId, config, options);
        if (oauth) runtime.pendingOAuth.add(oauth);
        if (generation !== runtime.generation) {
          await oauth?.close();
          return { config, status: "failed", tools: [], error: "Superseded" };
        }
        const connection = await connectMcpServer(config, {
          ...(oauth ? { oauth } : {}),
          ...(options.stderr ? { stderr: options.stderr } : {}),
        });
        if (generation !== runtime.generation) {
          await connection.close();
          return { config, status: "failed", tools: [], error: "Superseded" };
        }
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
      } finally {
        if (oauth) runtime.pendingOAuth.delete(oauth);
      }
    }),
  );
  if (generation === runtime.generation) runtime.states = states;
  return states;
}

async function oauthSessionForConfig(
  agentId: string,
  config: McpServerConfig,
  options: ReplaceClientMcpServersOptions,
) {
  if (config.transport !== "http" && config.transport !== "sse")
    return undefined;
  if (hasAuthorizationHeader(config.headers)) return undefined;
  return createMcpOAuthSession(agentId, config.name, config.url, {
    interactive: options.interactiveOAuth === true,
    ...(options.onStatus
      ? {
          onStatus: (message) =>
            options.onStatus?.(`${config.name}: ${message}`),
        }
      : {}),
  });
}

function hasAuthorizationHeader(headers?: Record<string, string>): boolean {
  return Object.keys(headers ?? {}).some(
    (name) => name.toLowerCase() === "authorization",
  );
}

/** Current local MCP connection state for the selected agent. */
export function getClientMcpServerStates(
  agentId: string,
): ClientMcpServerState[] {
  const runtime = getRuntime();
  return runtime.agentId === agentId ? [...runtime.states] : [];
}

/** Close every local MCP connection and unregister its tools. */
export async function closeClientMcpServers(): Promise<void> {
  const runtime = getRuntime();
  runtime.generation++;
  runtime.agentId = null;
  await closeActiveServers(runtime);
}

async function closeActiveServers(runtime: ClientMcpRuntime): Promise<void> {
  const pendingOAuth = [...runtime.pendingOAuth];
  const active = [...runtime.active.values()];
  runtime.pendingOAuth.clear();
  runtime.active.clear();
  runtime.states = [];
  for (const server of active) unregisterExternalTools(server.tools);
  await Promise.allSettled([
    ...pendingOAuth.map((oauth) => oauth.close()),
    ...active.map((server) => server.connection.close()),
  ]);
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
