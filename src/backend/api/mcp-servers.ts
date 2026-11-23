import type { McpServerListResponse } from "@letta-ai/letta-client/resources/mcp-servers/mcp-servers";
import type { Tool } from "@letta-ai/letta-client/resources/tools";

export type ServerMcpServer = McpServerListResponse[number];

export interface McpToolSchema {
  name: string;
  description?: string | null;
  health?: { status?: string | null } | null;
}

export interface ServerMcpClient {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  mcpServers: {
    list(): Promise<ServerMcpServer[]>;
    refresh(
      mcpServerId: string,
      params?: { agent_id?: string | null } | null,
    ): Promise<unknown>;
  };
  agents: {
    tools: {
      list(
        agentId: string,
        query?: { limit?: number } | null,
      ): AsyncIterable<Tool>;
      attach(toolId: string, params: { agent_id: string }): Promise<unknown>;
      detach(toolId: string, params: { agent_id: string }): Promise<unknown>;
    };
  };
}

export interface ServerMcpEntry {
  server: ServerMcpServer;
  tools: McpToolSchema[];
  toolsError?: string;
}

export interface AgentMcpAttachment {
  toolId: string;
  toolName: string;
  serverId?: string;
  serverName?: string;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

export function listServerMcpServers(
  client: ServerMcpClient,
  timeoutMs = 10_000,
): Promise<ServerMcpServer[]> {
  return withTimeout(
    client.mcpServers.list(),
    timeoutMs,
    "Listing server-side MCP servers",
  );
}

export async function listLiveServerMcpTools(
  client: ServerMcpClient,
  serverName: string,
  timeoutMs = 15_000,
): Promise<McpToolSchema[]> {
  const result = await withTimeout(
    client.get(`/v1/tools/mcp/servers/${encodeURIComponent(serverName)}/tools`),
    timeoutMs,
    `Listing tools for MCP server "${serverName}"`,
  );
  if (!Array.isArray(result)) return [];
  return result.filter(
    (tool): tool is McpToolSchema =>
      typeof tool === "object" &&
      tool !== null &&
      typeof (tool as { name?: unknown }).name === "string",
  );
}

export async function loadServerMcpEntries(
  client: ServerMcpClient,
  timeoutMs = 15_000,
): Promise<ServerMcpEntry[]> {
  const servers = await listServerMcpServers(client, timeoutMs);
  return Promise.all(
    servers.map(async (server): Promise<ServerMcpEntry> => {
      try {
        const tools = await listLiveServerMcpTools(
          client,
          server.server_name,
          timeoutMs,
        );
        return { server, tools };
      } catch (cause) {
        return {
          server,
          tools: [],
          toolsError: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }),
  );
}

function parseMcpMetadata(
  tool: Tool,
): { serverId?: string; serverName?: string } | null {
  const metadata = (tool as { metadata_?: { [key: string]: unknown } })
    .metadata_;
  const mcp = metadata?.mcp;
  if (typeof mcp !== "object" || mcp === null) return null;
  const { server_id, server_name } = mcp as {
    server_id?: unknown;
    server_name?: unknown;
  };
  return {
    ...(typeof server_id === "string" && { serverId: server_id }),
    ...(typeof server_name === "string" && { serverName: server_name }),
  };
}

export async function listAgentMcpAttachments(
  client: ServerMcpClient,
  agentId: string,
): Promise<AgentMcpAttachment[]> {
  const attachments: AgentMcpAttachment[] = [];
  for await (const tool of client.agents.tools.list(agentId, { limit: 100 })) {
    if (tool.tool_type !== "external_mcp" || !tool.id || !tool.name) continue;
    attachments.push({
      toolId: tool.id,
      toolName: tool.name,
      ...parseMcpMetadata(tool),
    });
  }
  return attachments;
}

export function attachmentsForEntry(
  entry: ServerMcpEntry,
  attachments: readonly AgentMcpAttachment[],
): AgentMcpAttachment[] {
  return attachments.filter((attachment) =>
    attachment.serverId && entry.server.id
      ? attachment.serverId === entry.server.id
      : attachment.serverName === entry.server.server_name,
  );
}

export function attachedToolNamesForEntry(
  entry: ServerMcpEntry,
  attachments: readonly AgentMcpAttachment[],
): Set<string> {
  return new Set(
    attachmentsForEntry(entry, attachments).map(
      (attachment) => attachment.toolName,
    ),
  );
}

export async function registerServerMcpTool(
  client: ServerMcpClient,
  serverName: string,
  toolName: string,
): Promise<{ id: string }> {
  const result = (await client.post(
    `/v1/tools/mcp/servers/${encodeURIComponent(serverName)}/${encodeURIComponent(toolName)}`,
  )) as { id?: unknown };
  if (typeof result?.id !== "string") {
    throw new Error(
      `Registering MCP tool "${toolName}" on server "${serverName}" returned no tool id`,
    );
  }
  return { id: result.id };
}

export async function attachServerMcpTools(
  client: ServerMcpClient,
  agentId: string,
  serverName: string,
  toolNames: string[],
): Promise<void> {
  await Promise.all(
    toolNames.map(async (toolName) => {
      const { id } = await registerServerMcpTool(client, serverName, toolName);
      await client.agents.tools.attach(id, { agent_id: agentId });
    }),
  );
}

export async function detachServerMcpTools(
  client: ServerMcpClient,
  agentId: string,
  toolIds: string[],
): Promise<void> {
  await Promise.all(
    toolIds.map((toolId) =>
      client.agents.tools.detach(toolId, { agent_id: agentId }),
    ),
  );
}

export function refreshServerMcpServer(
  client: ServerMcpClient,
  mcpServerId: string,
  agentId: string,
): Promise<unknown> {
  return client.mcpServers.refresh(mcpServerId, { agent_id: agentId });
}

export function planServerMcpToggle(
  entry: ServerMcpEntry,
  attachments: readonly AgentMcpAttachment[],
):
  | { action: "attach"; toolNames: string[] }
  | { action: "detach"; toolIds: string[] } {
  const attached = attachmentsForEntry(entry, attachments);
  if (attached.length > 0) {
    return {
      action: "detach",
      toolIds: attached.map((attachment) => attachment.toolId),
    };
  }
  return { action: "attach", toolNames: entry.tools.map((tool) => tool.name) };
}

export function describeServerMcpTarget(server: ServerMcpServer): string {
  if ("server_url" in server && server.server_url) {
    return server.server_url;
  }
  if ("command" in server && server.command) {
    return [server.command, ...(server.args ?? [])].join(" ");
  }
  return "";
}
