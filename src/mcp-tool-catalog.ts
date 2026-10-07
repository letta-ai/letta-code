import { actingUserRequestOptions } from "@/agent/acting-user";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import { getServerUrl } from "@/backend/api/server-url";
import {
  listUnifiedMcpServers,
  listUnifiedMcpTools,
  runUnifiedMcpTool,
  type UnifiedMcpClient,
  type UnifiedMcpRunResult,
  type UnifiedMcpServer,
} from "@/backend/api/unified-mcp";
import {
  type ConnectedMcpServer,
  connectMcpServer,
  type McpServerConfig,
  type McpToolDefinition,
  type McpToolResult,
} from "@/mcp-client";
import { createMcpOAuthSession } from "@/mcp-oauth";
import { formatClientMcpToolName } from "@/mcp-runtime";
import {
  assignMcpServerAliases,
  formatServerMcpToolName,
  uniqueMcpName,
} from "@/mcp-tool-names";
import { getRuntimeActingUserId } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { isRecord } from "@/utils/type-guards";

export type McpServerTarget =
  | { kind: "client"; config: McpServerConfig }
  | { kind: "server"; server: UnifiedMcpServer };
export type McpToolTarget =
  | { kind: "client"; connection: ConnectedMcpServer; rawName: string }
  | { kind: "server"; serverId: string; toolId: string };
export interface McpCatalogTool {
  schema: McpToolDefinition;
  target: McpToolTarget;
}
export interface McpToolCatalog {
  tools: McpCatalogTool[];
  excludedHostedStdioServers: boolean;
  close(): Promise<void>;
}
export interface McpCatalogDependencies {
  getLocalServers?: (agentId: string) => McpServerConfig[];
  connectLocalServer?: typeof connectMcpServer;
  createOAuthSession?: typeof createMcpOAuthSession;
  getClient?: () => Promise<UnifiedMcpClient>;
  isServerMcpAvailable?: () => boolean;
  isHostedLettaCloud?: () => boolean;
  stderr?: (message: string) => unknown;
}

function hostedCloud(): boolean {
  try {
    return getServerUrl() === LETTA_CLOUD_API_URL;
  } catch {
    return !process.env.LETTA_BASE_URL;
  }
}
export function localMcpServers(
  deps: McpCatalogDependencies,
  agentId: string,
): McpServerConfig[] {
  return (deps.getLocalServers ?? ((id) => settingsManager.getMcpServers(id)))(
    agentId,
  );
}
export function serverMcpAvailable(deps: McpCatalogDependencies): boolean {
  return (
    deps.isServerMcpAvailable ??
    (() => getBackend().capabilities.serverSideToolManagement)
  )();
}
export async function serverMcpClient(
  deps: McpCatalogDependencies,
): Promise<UnifiedMcpClient> {
  if (deps.getClient) return deps.getClient();
  const client = await getClient();
  const actingUser = actingUserRequestOptions(getRuntimeActingUserId());
  return {
    get: (path) => client.get(path, actingUser),
    post: (path, options) => client.post(path, { ...options, ...actingUser }),
    mcpServers: { list: () => client.mcpServers.list(actingUser) },
  };
}
export async function listMcpServerTargets(
  deps: McpCatalogDependencies,
  agentId: string,
): Promise<McpServerTarget[]> {
  const local = localMcpServers(deps, agentId).map(
    (config): McpServerTarget => ({ kind: "client", config }),
  );
  if (!serverMcpAvailable(deps)) return local;
  const connected = await listUnifiedMcpServers(
    await serverMcpClient(deps),
    agentId,
  );
  return [
    ...local,
    ...connected.map((server): McpServerTarget => ({ kind: "server", server })),
  ];
}
function key(target: McpServerTarget): string {
  return target.kind === "client"
    ? `client:${target.config.name}`
    : `server:${target.server.id}`;
}
function name(target: McpServerTarget): string {
  return target.kind === "client"
    ? target.config.name
    : target.server.serverName;
}
function hasAuthorizationHeader(config: McpServerConfig): boolean {
  return (
    (config.transport === "http" || config.transport === "sse") &&
    Object.keys(config.headers ?? {}).some(
      (header) => header.toLowerCase() === "authorization",
    )
  );
}
async function connectConfigured(
  deps: McpCatalogDependencies,
  agentId: string,
  config: McpServerConfig,
): Promise<ConnectedMcpServer> {
  const oauth =
    (config.transport === "http" || config.transport === "sse") &&
    !hasAuthorizationHeader(config)
      ? await (deps.createOAuthSession ?? createMcpOAuthSession)(
          agentId,
          config.name,
          config.url,
          {
            interactive: false,
            onStatus: (message) => {
              void deps.stderr?.(message);
            },
          },
        )
      : undefined;
  return (deps.connectLocalServer ?? connectMcpServer)(config, {
    ...(oauth ? { oauth } : {}),
    stderr: "pipe",
  });
}

/** One catalog shared by the CLI and CodeMode. Tool targets never leave the host. */
export async function buildMcpToolCatalog(
  deps: McpCatalogDependencies,
  agentId: string,
  options: {
    serverSelector?: string;
    toolName?: string;
    targetKind?: McpServerTarget["kind"];
  } = {},
): Promise<McpToolCatalog> {
  const servers = await listMcpServerTargets(deps, agentId);
  const aliases = assignMcpServerAliases(
    servers.map((target) => ({
      key: key(target),
      name: name(target),
      kind: target.kind,
    })),
  );
  let active = options.targetKind
    ? servers.filter((target) => target.kind === options.targetKind)
    : servers;
  if (options.serverSelector) {
    const matches = servers.filter(
      (target) =>
        name(target) === options.serverSelector ||
        (target.kind === "server" &&
          target.server.id === options.serverSelector),
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Multiple MCP servers are named '${options.serverSelector}'`
          : `No MCP server named '${options.serverSelector}' is available`,
      );
    const selected = matches[0];
    if (!selected) throw new Error("MCP server selection unavailable");
    active = servers.filter((target) => key(target) === key(selected));
  } else if (options.toolName) {
    active = servers.filter(
      (target) =>
        options.toolName?.startsWith(`mcp__${aliases.get(key(target))}__`) ===
        true,
    );
  }
  const tools: McpCatalogTool[] = [];
  const connections: ConnectedMcpServer[] = [];
  const usedNames = new Set<string>();
  try {
    const allServerTargets = active.filter(
      (target): target is Extract<McpServerTarget, { kind: "server" }> =>
        target.kind === "server",
    );
    const serverTargets = (deps.isHostedLettaCloud ?? hostedCloud)()
      ? allServerTargets.filter(({ server }) => server.serverType !== "stdio")
      : allServerTargets;
    if (serverTargets.length) {
      const client = await serverMcpClient(deps);
      const lists = await Promise.all(
        serverTargets.map(async ({ server }) => ({
          server,
          list: await listUnifiedMcpTools(client, agentId, server.id),
        })),
      );
      for (const { server, list } of lists) {
        const alias = aliases.get(`server:${server.id}`);
        if (!alias) throw new Error("MCP server alias missing");
        for (const tool of [...list].sort((a, b) => a.id.localeCompare(b.id))) {
          const toolName = uniqueMcpName(
            formatServerMcpToolName(server.serverName, alias, tool.name),
            usedNames,
          );
          tools.push({
            schema: {
              name: toolName,
              ...(tool.title ? { title: tool.title } : {}),
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: tool.inputSchema,
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
              ...(tool.execution ? { execution: tool.execution } : {}),
              ...(tool._meta ? { _meta: tool._meta } : {}),
              ...(tool.icons ? { icons: tool.icons } : {}),
            },
            target: { kind: "server", serverId: server.id, toolId: tool.id },
          });
        }
      }
    }
    const clients = active.filter(
      (target): target is Extract<McpServerTarget, { kind: "client" }> =>
        target.kind === "client",
    );
    const settled = await Promise.allSettled(
      clients.map(async ({ config }) => ({
        config,
        connection: await connectConfigured(deps, agentId, config),
      })),
    );
    for (const result of settled)
      if (result.status === "fulfilled")
        connections.push(result.value.connection);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const { config, connection } = result.value;
      const alias = aliases.get(`client:${config.name}`);
      if (!alias) throw new Error("MCP server alias missing");
      for (const tool of connection.tools) {
        const toolName = uniqueMcpName(
          formatClientMcpToolName(alias, tool.name),
          usedNames,
        );
        tools.push({
          schema: { ...tool, name: toolName },
          target: { kind: "client", connection, rawName: tool.name },
        });
      }
    }
    return {
      tools,
      excludedHostedStdioServers:
        serverTargets.length !== allServerTargets.length,
      close: async () => {
        await Promise.allSettled(
          connections.map((connection) => connection.close()),
        );
      },
    };
  } catch (error) {
    await Promise.allSettled(
      connections.map((connection) => connection.close()),
    );
    throw error;
  }
}

export function normalizeMcpRunResult(
  result: UnifiedMcpRunResult,
): McpToolResult {
  const value = result.funcReturn;
  const normalized: McpToolResult =
    isRecord(value) && Array.isArray(value.content)
      ? {
          content: value.content,
          ...(value.isError === true ? { isError: true } : {}),
          ...(isRecord(value.structuredContent)
            ? { structuredContent: value.structuredContent }
            : {}),
          ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
        }
      : isRecord(value)
        ? {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          }
        : value == null
          ? { content: [] }
          : {
              content: [
                {
                  type: "text",
                  text:
                    typeof value === "string" ? value : JSON.stringify(value),
                },
              ],
            };
  return {
    ...normalized,
    isError: result.status !== "success" || normalized.isError === true,
  };
}
export async function callMcpCatalogTool(
  tool: McpCatalogTool,
  agentId: string,
  args: Record<string, unknown>,
  deps: McpCatalogDependencies = {},
  signal?: AbortSignal,
  recheckAssociation = false,
): Promise<McpToolResult> {
  if (signal?.aborted) throw new Error("Aborted");
  const target = tool.target;
  if (target.kind === "client")
    return target.connection.callTool(target.rawName, args, { signal });
  // Recheck association and tool membership before running a previously catalogued ID.
  const client = await serverMcpClient(deps);
  if (recheckAssociation) {
    const servers = await listUnifiedMcpServers(client, agentId);
    if (!servers.some((server) => server.id === target.serverId))
      throw new Error("MCP server association unavailable");
    const available = await listUnifiedMcpTools(
      client,
      agentId,
      target.serverId,
    );
    if (!available.some((candidate) => candidate.id === target.toolId))
      throw new Error("MCP tool unavailable");
  }
  if (signal?.aborted) throw new Error("Aborted");
  return normalizeMcpRunResult(
    await runUnifiedMcpTool({
      client,
      agentId,
      mcpServerId: target.serverId,
      toolId: target.toolId,
      args,
      signal,
    }),
  );
}
