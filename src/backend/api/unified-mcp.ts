import { isRecord } from "@/utils/type-guards";

// Keep this adapter separate from mcp-servers.ts. That module backs the legacy
// `letta cloud-mcp` contract, whose request and output shapes stay frozen while
// the unified `letta mcp` command replaces it.
/** Structural API surface used only by the unified `letta mcp` command. */
export interface UnifiedMcpClient {
  get(path: string): Promise<unknown>;
  post(path: string, options?: { body?: unknown }): Promise<unknown>;
  mcpServers?: {
    list(): Promise<unknown[]>;
  };
}

export interface UnifiedMcpServer {
  id: string;
  serverName: string;
  serverType: string;
  target: string;
  command?: string;
  args?: string[];
  serverUrl?: string;
}

export interface UnifiedMcpTool {
  id: string;
  name: string;
  title?: string;
  description?: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  icons?: Array<Record<string, unknown>>;
}

export interface UnifiedMcpRunResult {
  status: string;
  funcReturn?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export type UnifiedMcpSearchMode = "vector" | "fts" | "hybrid";

export interface UnifiedMcpSearchResult {
  toolId: string;
  jsonSchema: Record<string, unknown> | null;
  score: number;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function recordField(
  value: Record<string, unknown>,
  ...names: string[]
): Record<string, unknown> | undefined {
  for (const name of names) {
    const field = value[name];
    if (isRecord(field)) return field;
  }
  return undefined;
}

function parseServer(
  value: unknown,
  registered: Record<string, unknown> | undefined,
): UnifiedMcpServer | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const serverName =
    stringField(value, "server_name") ??
    (registered ? stringField(registered, "server_name") : null);
  const serverType =
    stringField(value, "mcp_server_type") ??
    (registered ? stringField(registered, "mcp_server_type") : null) ??
    "unknown";
  if (!id || !serverName) return null;

  const serverUrl =
    stringField(value, "server_url") ??
    (registered ? stringField(registered, "server_url") : null) ??
    undefined;
  const command =
    stringField(value, "command") ??
    (registered ? stringField(registered, "command") : null) ??
    undefined;
  const argsValue = value.args ?? registered?.args;
  const args = Array.isArray(argsValue)
    ? argsValue.filter((item): item is string => typeof item === "string")
    : [];
  const target = serverUrl ?? [command, ...args].filter(Boolean).join(" ");
  return {
    id,
    serverName,
    serverType,
    target,
    ...(serverUrl ? { serverUrl } : {}),
    ...(command ? { command, args } : {}),
  };
}

function parseTool(value: unknown): UnifiedMcpTool | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const name = stringField(value, "name");
  if (!id || !name) return null;

  const description = stringField(value, "description");
  const jsonSchema = isRecord(value.json_schema) ? value.json_schema : {};
  const inputSchema = isRecord(jsonSchema.parameters)
    ? jsonSchema.parameters
    : isRecord(value.args_json_schema)
      ? value.args_json_schema
      : { type: "object", properties: {} };
  const title = stringField(value, "title") ?? stringField(jsonSchema, "title");
  const outputSchema =
    recordField(value, "outputSchema", "output_schema") ??
    recordField(jsonSchema, "outputSchema", "output_schema");
  const annotations =
    recordField(value, "annotations") ?? recordField(jsonSchema, "annotations");
  const execution =
    recordField(value, "execution") ?? recordField(jsonSchema, "execution");
  const meta = recordField(value, "_meta") ?? recordField(jsonSchema, "_meta");
  const iconsValue = value.icons ?? jsonSchema.icons;
  const icons = Array.isArray(iconsValue)
    ? iconsValue.filter(isRecord)
    : undefined;
  return {
    id,
    name,
    ...(title ? { title } : {}),
    description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
    ...(execution ? { execution } : {}),
    ...(meta ? { _meta: meta } : {}),
    ...(icons ? { icons } : {}),
  };
}

function parseRunResult(value: unknown): UnifiedMcpRunResult {
  if (!isRecord(value)) throw new Error("Invalid MCP tool run response");
  return {
    status: stringField(value, "status") ?? "unknown",
    funcReturn: value.func_return,
    stdout: value.stdout,
    stderr: value.stderr,
  };
}

function parseSearchResult(value: unknown): UnifiedMcpSearchResult | null {
  if (!isRecord(value) || !isRecord(value.tool)) return null;
  const toolId = stringField(value.tool, "id");
  const jsonSchema = value.tool.json_schema;
  const score = value.combined_score;
  if (
    !toolId ||
    (jsonSchema !== null && !isRecord(jsonSchema)) ||
    typeof score !== "number"
  ) {
    return null;
  }
  return { toolId, jsonSchema, score };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function listUnifiedMcpServers(
  client: UnifiedMcpClient,
  agentId: string,
  timeoutMs = 10_000,
): Promise<UnifiedMcpServer[]> {
  const value = await withTimeout(
    client.get(`/v1/agents/${encodeURIComponent(agentId)}/mcp-servers`),
    timeoutMs,
    "Listing agent MCP servers",
  );
  if (!Array.isArray(value)) return [];
  const needsEnrichment = value.some(
    (item) => isRecord(item) && !stringField(item, "mcp_server_type"),
  );
  const registeredById = new Map<string, Record<string, unknown>>();
  if (needsEnrichment && client.mcpServers) {
    try {
      const registered = await withTimeout(
        client.mcpServers.list(),
        timeoutMs,
        "Listing registered MCP servers",
      );
      for (const item of registered) {
        if (!isRecord(item)) continue;
        const id = stringField(item, "id");
        if (id) registeredById.set(id, item);
      }
    } catch {
      // The association id/name still owns tool listing and execution. Keep it
      // with unknown transport when optional connection metadata is unavailable.
    }
  }
  return value
    .map((item) => {
      const registered = isRecord(item)
        ? registeredById.get(stringField(item, "id") ?? "")
        : undefined;
      return parseServer(item, registered);
    })
    .filter((server) => server !== null);
}

export async function listUnifiedMcpTools(
  client: UnifiedMcpClient,
  agentId: string,
  mcpServerId: string,
  timeoutMs = 10_000,
): Promise<UnifiedMcpTool[]> {
  const value = await withTimeout(
    client.get(
      `/v1/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(mcpServerId)}/tools`,
    ),
    timeoutMs,
    "Listing agent MCP server tools",
  );
  if (!Array.isArray(value)) return [];
  return value.map(parseTool).filter((tool) => tool !== null);
}

export async function searchUnifiedMcpTools(params: {
  client: Pick<UnifiedMcpClient, "post">;
  agentId: string;
  query: string;
  searchMode: UnifiedMcpSearchMode;
  limit: number;
  timeoutMs?: number;
}): Promise<UnifiedMcpSearchResult[]> {
  const value = await withTimeout(
    params.client.post(
      `/v1/agents/${encodeURIComponent(params.agentId)}/mcp-servers/tools/search`,
      {
        body: {
          query: params.query,
          search_mode: params.searchMode,
          limit: params.limit,
        },
      },
    ),
    params.timeoutMs ?? 60_000,
    "Searching agent MCP tools",
  );
  if (!Array.isArray(value)) {
    throw new Error("Invalid MCP tool search response");
  }
  const results: UnifiedMcpSearchResult[] = [];
  for (const item of value) {
    const result = parseSearchResult(item);
    if (!result) throw new Error("Invalid MCP tool search result");
    results.push(result);
  }
  return results;
}

export async function runUnifiedMcpTool(params: {
  client: UnifiedMcpClient;
  agentId: string;
  mcpServerId: string;
  toolId: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<UnifiedMcpRunResult> {
  const value = await withTimeout(
    params.client.post(
      `/v1/agents/${encodeURIComponent(params.agentId)}/mcp-servers/${encodeURIComponent(params.mcpServerId)}/tools/${encodeURIComponent(params.toolId)}/run`,
      { body: { args: params.args } },
    ),
    params.timeoutMs ?? 60_000,
    "Running agent MCP tool",
  );
  return parseRunResult(value);
}
