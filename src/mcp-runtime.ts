import {
  type ConnectedMcpServer,
  connectMcpServer,
  type McpOAuthConnection,
  type McpServerConfig,
  type McpToolDefinition,
} from "@/mcp-client";
import { createMcpOAuthSession } from "@/mcp-oauth";

export interface ClientMcpServerState {
  config: McpServerConfig;
  status: "connected" | "failed";
  tools: McpToolDefinition[];
  error?: string;
}

interface ActiveMcpServer {
  connection: ConnectedMcpServer;
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

/** Replace client-local MCP connections used by the interactive MCP manager. */
export async function replaceClientMcpServers(
  agentId: string,
  configs: readonly McpServerConfig[],
  options: ReplaceClientMcpServersOptions = {},
): Promise<ClientMcpServerState[]> {
  const runtime = getRuntime();
  const generation = ++runtime.generation;
  await closeActiveServers(runtime);
  runtime.agentId = agentId;
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
        runtime.active.set(config.name, { connection });
        return { config, status: "connected", tools: connection.tools };
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

/** Close every local MCP manager connection. */
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
  await Promise.allSettled([
    ...pendingOAuth.map((oauth) => oauth.close()),
    ...active.map((server) => server.connection.close()),
  ]);
}

/** Return the CLI name for a tool from a client-connected MCP server. */
export function formatClientMcpToolName(
  serverName: string,
  toolName: string,
): string {
  return `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(toolName)}`;
}

export function normalizeMcpName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized || "tool";
}
