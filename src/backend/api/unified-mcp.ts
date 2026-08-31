import { isRecord } from "@/utils/type-guards";

// Keep this adapter separate from mcp-servers.ts. That module backs the legacy
// `letta cloud-mcp` contract, whose request and output shapes stay frozen while
// the unified `letta mcp` command replaces it.
/** Structural API surface used only by the unified `letta mcp` command. */
export interface UnifiedMcpClient {
  get(path: string): Promise<unknown>;
  post(path: string, options?: { body?: unknown }): Promise<unknown>;
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

function parseServer(value: unknown): UnifiedMcpServer | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const serverName = stringField(value, "server_name");
  const serverType = stringField(value, "mcp_server_type");
  if (!id || !serverName || !serverType) return null;

  const serverUrl = stringField(value, "server_url") ?? undefined;
  const command = stringField(value, "command") ?? undefined;
  const args = Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === "string")
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
  return value.map(parseServer).filter((server) => server !== null);
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
