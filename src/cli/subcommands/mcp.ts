import { parseArgs } from "node:util";
import { getBackend } from "@/backend";
import { getClient as getDefaultClient } from "@/backend/api/client";
import {
  type AgentConnectedMcpServer,
  type AgentMcpToolRunResult,
  connectAgentMcpServer,
  disconnectAgentMcpServer,
  listAgentConnectedMcpServers,
  listAgentConnectedMcpTools,
  listServerMcpServers,
  runAgentConnectedMcpTool,
  type ServerMcpClient,
} from "@/backend/api/mcp-servers";
import {
  type ConnectedMcpServer,
  connectMcpServer,
  type McpOAuthConnection,
  type McpServerConfig,
  type McpToolDefinition,
  type McpToolResult,
} from "@/mcp-client";
import { buildMcpServerConfig, parseMcpTransport } from "@/mcp-config";
import { clearMcpOAuthCredentials, createMcpOAuthSession } from "@/mcp-oauth";
import { formatClientMcpToolName } from "@/mcp-runtime";
import { settingsManager } from "@/settings-manager";
import { isRecord } from "@/utils/type-guards";
import { loadMcpToolArgs, printMcpUsage, resolveMcpAgentId } from "./mcp-io";

type McpTransport = "stdio" | "streamable_http" | "sse";

interface McpServerSummary {
  name: string;
  transport: McpTransport;
}

type McpServerDetails =
  | (McpServerSummary & {
      transport: "stdio";
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
    })
  | (McpServerSummary & {
      transport: "streamable_http" | "sse";
      url: string;
      headers: Record<string, string>;
    });

type ServerTarget =
  | { kind: "client"; config: McpServerConfig }
  | { kind: "server"; server: AgentConnectedMcpServer };

type ToolTarget =
  | {
      kind: "client";
      connection: ConnectedMcpServer;
      rawName: string;
    }
  | {
      kind: "server";
      serverId: string;
      toolId: string;
    };

interface CatalogTool {
  schema: McpToolDefinition;
  target: ToolTarget;
  serverKey: string;
}

interface ToolCatalog {
  tools: CatalogTool[];
  close(): Promise<void>;
}

export interface McpSubcommandDependencies {
  initializeSettings?: () => Promise<void>;
  flushSettings?: () => Promise<void>;
  getLocalServers?: (agentId: string) => McpServerConfig[];
  setLocalServers?: (agentId: string, servers: McpServerConfig[]) => void;
  connectLocalServer?: typeof connectMcpServer;
  createOAuthSession?: typeof createMcpOAuthSession;
  clearOAuthCredentials?: typeof clearMcpOAuthCredentials;
  getClient?: () => Promise<ServerMcpClient>;
  isServerMcpAvailable?: () => boolean;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

interface ParsedMcpArgs {
  action?: string;
  target?: string;
  values: ReturnType<typeof parseMcpArgs>["values"];
  childCommand: string[];
}

class McpCliError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "McpCliError";
    this.code = code;
    this.hint = hint;
  }
}

function parseMcpArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      agent: { type: "string" },
      "agent-id": { type: "string" },
      transport: { type: "string" },
      url: { type: "string" },
      cwd: { type: "string" },
      env: { type: "string", multiple: true },
      header: { type: "string", multiple: true },
      "auth-env": { type: "string" },
      "no-verify": { type: "boolean" },
      force: { type: "boolean" },
      args: { type: "string" },
      "args-file": { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
}

function parseCommandLine(argv: string[]): ParsedMcpArgs {
  const separator = argv.indexOf("--");
  const commandArgs = separator === -1 ? argv : argv.slice(0, separator);
  const childCommand = separator === -1 ? [] : argv.slice(separator + 1);
  const parsed = parseMcpArgs(commandArgs);
  const [action, target, ...extra] = parsed.positionals;
  if (extra.length > 0) {
    throw new McpCliError(
      "invalid_arguments",
      `Unexpected positional arguments: ${extra.join(" ")}`,
    );
  }
  return { action, target, values: parsed.values, childCommand };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function getLocalServers(
  deps: McpSubcommandDependencies,
  agentId: string,
): McpServerConfig[] {
  return (deps.getLocalServers ?? ((id) => settingsManager.getMcpServers(id)))(
    agentId,
  );
}

function serverMcpAvailable(deps: McpSubcommandDependencies): boolean {
  return (
    deps.isServerMcpAvailable ??
    (() => getBackend().capabilities.serverSideToolManagement)
  )();
}

async function getServerClient(
  deps: McpSubcommandDependencies,
): Promise<ServerMcpClient> {
  if (deps.getClient) return deps.getClient();
  return (await getDefaultClient()) as ServerMcpClient;
}

function localTransport(config: McpServerConfig): McpTransport {
  if (config.transport === "http") return "streamable_http";
  return config.transport ?? "stdio";
}

function serverTransport(server: AgentConnectedMcpServer): McpTransport {
  if (server.serverType === "streamable_http") return "streamable_http";
  if (server.serverType === "sse") return "sse";
  return "stdio";
}

function serverSummary(target: ServerTarget): McpServerSummary {
  return target.kind === "client"
    ? { name: target.config.name, transport: localTransport(target.config) }
    : {
        name: target.server.serverName,
        transport: serverTransport(target.server),
      };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    const sensitive = /token|key|secret|password|signature|credential/i;
    for (const key of url.searchParams.keys()) {
      if (sensitive.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function serverDetails(target: ServerTarget): McpServerDetails {
  if (target.kind === "client") {
    const config = target.config;
    if (config.transport === "http" || config.transport === "sse") {
      return {
        name: config.name,
        transport: config.transport === "http" ? "streamable_http" : "sse",
        url: redactUrl(config.url),
        headers: redactValues(config.headers),
      };
    }
    return {
      name: config.name,
      transport: "stdio",
      command: config.command,
      args: config.args ?? [],
      ...(config.cwd ? { cwd: config.cwd } : {}),
      env: redactValues(config.env),
    };
  }

  const server = target.server;
  if (server.serverType === "stdio") {
    return {
      name: server.serverName,
      transport: "stdio",
      command: server.command ?? server.target.split(" ")[0] ?? "",
      args: server.args ?? [],
      env: {},
    };
  }
  return {
    name: server.serverName,
    transport: serverTransport(server) as "streamable_http" | "sse",
    url: redactUrl(server.serverUrl ?? server.target),
    headers: {},
  };
}

function redactValues(
  values: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(values ?? {})
      .sort()
      .map((name) => [name, "[REDACTED]"]),
  );
}

async function listUnifiedServers(
  deps: McpSubcommandDependencies,
  agentId: string,
): Promise<ServerTarget[]> {
  const local = getLocalServers(deps, agentId).map(
    (config): ServerTarget => ({ kind: "client", config }),
  );
  if (!serverMcpAvailable(deps)) return local;
  const client = await getServerClient(deps);
  const connected = await listAgentConnectedMcpServers(client, agentId);
  return [
    ...local,
    ...connected.map((server): ServerTarget => ({ kind: "server", server })),
  ];
}

function resolveServer(
  targets: ServerTarget[],
  selector: string,
): ServerTarget {
  const matches = targets.filter((target) => {
    if (target.kind === "client") return target.config.name === selector;
    return (
      target.server.serverName === selector || target.server.id === selector
    );
  });
  if (matches.length === 0) {
    throw new McpCliError(
      "server_not_found",
      `No MCP server named '${selector}' is available`,
    );
  }
  if (matches.length > 1) {
    throw new McpCliError(
      "ambiguous_server_name",
      `Multiple MCP servers are named '${selector}'`,
      "Use the opaque server id returned by the Letta API to disambiguate this legacy collision.",
    );
  }
  const match = matches[0];
  if (!match) throw new Error("Resolved MCP server disappeared");
  return match;
}

function hasAuthorizationHeader(config: McpServerConfig): boolean {
  return (
    (config.transport === "http" || config.transport === "sse") &&
    Object.keys(config.headers ?? {}).some(
      (name) => name.toLowerCase() === "authorization",
    )
  );
}

async function oauthForConfig(
  deps: McpSubcommandDependencies,
  agentId: string,
  config: McpServerConfig,
  interactive: boolean,
): Promise<McpOAuthConnection | undefined> {
  if (config.transport !== "http" && config.transport !== "sse")
    return undefined;
  if (hasAuthorizationHeader(config)) return undefined;
  const create = deps.createOAuthSession ?? createMcpOAuthSession;
  return create(agentId, config.name, config.url, {
    interactive,
    onStatus: (message) => (deps.stderr ?? console.error)(message),
  });
}

async function connectConfiguredServer(
  deps: McpSubcommandDependencies,
  agentId: string,
  config: McpServerConfig,
  interactive: boolean,
): Promise<ConnectedMcpServer> {
  const oauth = await oauthForConfig(deps, agentId, config, interactive);
  return (deps.connectLocalServer ?? connectMcpServer)(config, {
    ...(oauth ? { oauth } : {}),
    stderr: "pipe",
  });
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

function serverKey(target: ServerTarget): string {
  return target.kind === "client"
    ? `client:${target.config.name}`
    : `server:${target.server.id}`;
}

async function buildToolCatalog(
  deps: McpSubcommandDependencies,
  agentId: string,
  serverSelector?: string,
): Promise<ToolCatalog> {
  const servers = await listUnifiedServers(deps, agentId);
  const selectedKey = serverSelector
    ? serverKey(resolveServer(servers, serverSelector))
    : undefined;
  const catalog: CatalogTool[] = [];
  const connections: ConnectedMcpServer[] = [];
  const usedNames = new Set<string>();

  try {
    const serverTargets = servers.filter(
      (target): target is Extract<ServerTarget, { kind: "server" }> =>
        target.kind === "server",
    );
    if (serverTargets.length > 0) {
      const client = await getServerClient(deps);
      const toolLists = await Promise.all(
        serverTargets.map(async ({ server }) => ({
          server,
          tools: await listAgentConnectedMcpTools(client, agentId, server.id),
        })),
      );
      for (const { server, tools } of toolLists) {
        for (const tool of tools) {
          const name = uniqueToolName(tool.name, usedNames);
          catalog.push({
            schema: {
              name,
              ...(tool.title ? { title: tool.title } : {}),
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: tool.inputSchema,
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
              ...(tool.annotations ? { annotations: tool.annotations } : {}),
              ...(tool.execution ? { execution: tool.execution } : {}),
              ...(tool._meta ? { _meta: tool._meta } : {}),
              ...(tool.icons ? { icons: tool.icons } : {}),
            },
            target: {
              kind: "server",
              serverId: server.id,
              toolId: tool.id,
            },
            serverKey: `server:${server.id}`,
          });
        }
      }
    }

    const clientTargets = servers.filter(
      (target): target is Extract<ServerTarget, { kind: "client" }> =>
        target.kind === "client",
    );
    const settled = await Promise.allSettled(
      clientTargets.map(async ({ config }) => ({
        config,
        connection: await connectConfiguredServer(deps, agentId, config, false),
      })),
    );
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    for (const result of settled) {
      if (result.status === "fulfilled")
        connections.push(result.value.connection);
    }
    if (rejected) throw rejected.reason;

    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const { config, connection } = result.value;
      for (const tool of connection.tools) {
        const name = uniqueToolName(
          formatClientMcpToolName(config.name, tool.name),
          usedNames,
        );
        catalog.push({
          schema: { ...tool, name },
          target: { kind: "client", connection, rawName: tool.name },
          serverKey: `client:${config.name}`,
        });
      }
    }

    return {
      tools: selectedKey
        ? catalog.filter((tool) => tool.serverKey === selectedKey)
        : catalog,
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

function buildLocalConfig(
  parsed: ParsedMcpArgs,
  deps: McpSubcommandDependencies,
): McpServerConfig {
  const name = parsed.target;
  let transport: ReturnType<typeof parseMcpTransport>;
  try {
    transport = parseMcpTransport(stringValue(parsed.values.transport));
  } catch (error) {
    throw new McpCliError(
      "invalid_arguments",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!name || !transport) {
    throw new McpCliError(
      "invalid_arguments",
      "A server name and --transport are required for a new connection",
    );
  }

  try {
    return buildMcpServerConfig(name, {
      transport,
      url: stringValue(parsed.values.url),
      cwd: stringValue(parsed.values.cwd),
      env: stringValues(parsed.values.env),
      headers: stringValues(parsed.values.header),
      authEnv: stringValue(parsed.values["auth-env"]),
      childCommand: parsed.childCommand,
      defaultCwd: (deps.cwd ?? process.cwd)(),
    });
  } catch (error) {
    throw new McpCliError(
      "invalid_arguments",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function saveLocalServers(
  deps: McpSubcommandDependencies,
  agentId: string,
  servers: McpServerConfig[],
): Promise<void> {
  (
    deps.setLocalServers ??
    ((id, value) => settingsManager.setMcpServers(id, value))
  )(agentId, servers);
  await (deps.flushSettings ?? (() => settingsManager.flush()))();
}

function mcpToolResultFromServer(result: AgentMcpToolRunResult): McpToolResult {
  const success = result.status === "success";
  const value = result.funcReturn;
  let normalized: McpToolResult;
  if (isRecord(value) && Array.isArray(value.content)) {
    normalized = {
      content: value.content,
      ...(value.isError === true ? { isError: true } : {}),
      ...(isRecord(value.structuredContent)
        ? { structuredContent: value.structuredContent }
        : {}),
      ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
    };
  } else if (isRecord(value)) {
    normalized = {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    };
  } else if (value === undefined || value === null) {
    normalized = { content: [] };
  } else {
    normalized = {
      content: [
        {
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value),
        },
      ],
    };
  }
  return {
    ...normalized,
    isError: !success || normalized.isError === true,
  };
}

function printJson(stdout: (message: string) => void, value: unknown): void {
  stdout(JSON.stringify(value, null, 2));
}

function printError(stderr: (message: string) => void, error: unknown): void {
  const normalized =
    error instanceof McpCliError
      ? error
      : new McpCliError(
          "mcp_error",
          error instanceof Error ? error.message : String(error),
        );
  stderr(
    JSON.stringify(
      {
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.hint ? { hint: normalized.hint } : {}),
        },
      },
      null,
      2,
    ),
  );
}

async function runList(
  deps: McpSubcommandDependencies,
  agentId: string,
  stdout: (message: string) => void,
): Promise<number> {
  const servers = await listUnifiedServers(deps, agentId);
  printJson(stdout, servers.map(serverSummary));
  return 0;
}

async function runGet(
  deps: McpSubcommandDependencies,
  agentId: string,
  selector: string | undefined,
  stdout: (message: string) => void,
): Promise<number> {
  if (!selector) {
    throw new McpCliError("invalid_arguments", "Usage: letta mcp get <server>");
  }
  const server = resolveServer(
    await listUnifiedServers(deps, agentId),
    selector,
  );
  printJson(stdout, serverDetails(server));
  return 0;
}

async function runAdd(
  parsed: ParsedMcpArgs,
  deps: McpSubcommandDependencies,
  agentId: string,
  stdout: (message: string) => void,
): Promise<number> {
  let transport: ReturnType<typeof parseMcpTransport>;
  try {
    transport = parseMcpTransport(stringValue(parsed.values.transport));
  } catch (error) {
    throw new McpCliError(
      "invalid_arguments",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!transport) {
    const selector = parsed.target;
    if (!selector) {
      throw new McpCliError(
        "invalid_arguments",
        "Usage: letta mcp add <server>",
      );
    }
    if (!serverMcpAvailable(deps)) {
      throw new McpCliError(
        "server_not_found",
        `No registered MCP server named '${selector}' is available`,
      );
    }
    const client = await getServerClient(deps);
    const available = await listServerMcpServers(client);
    const matches = available.filter(
      (server) => server.server_name === selector || server.id === selector,
    );
    if (matches.length !== 1) {
      throw new McpCliError(
        matches.length === 0 ? "server_not_found" : "ambiguous_server_name",
        matches.length === 0
          ? `No registered MCP server named '${selector}' is available`
          : `Multiple registered MCP servers are named '${selector}'`,
      );
    }
    const server = matches[0];
    if (!server?.id) {
      throw new McpCliError(
        "server_not_found",
        `MCP server '${selector}' has no stable id`,
      );
    }
    await connectAgentMcpServer(client, agentId, server.id);
    const tools = await listAgentConnectedMcpTools(client, agentId, server.id);
    printJson(stdout, {
      ok: true,
      server: {
        name: server.server_name,
        transport:
          server.mcp_server_type === "streamable_http"
            ? "streamable_http"
            : server.mcp_server_type,
      },
      toolCount: tools.length,
    });
    return 0;
  }

  const config = buildLocalConfig(parsed, deps);
  const existing = await listUnifiedServers(deps, agentId);
  if (existing.some((target) => serverSummary(target).name === config.name)) {
    throw new McpCliError(
      "server_already_exists",
      `MCP server '${config.name}' is already available`,
    );
  }

  let toolCount: number | undefined;
  if (parsed.values["no-verify"] !== true) {
    const connection = await connectConfiguredServer(
      deps,
      agentId,
      config,
      true,
    );
    try {
      toolCount = connection.tools.length;
    } finally {
      await connection.close();
    }
  }
  await saveLocalServers(deps, agentId, [
    ...getLocalServers(deps, agentId),
    config,
  ]);
  printJson(stdout, {
    ok: true,
    server: serverSummary({ kind: "client", config }),
    ...(toolCount !== undefined ? { toolCount } : {}),
  });
  return 0;
}

async function runRemove(
  deps: McpSubcommandDependencies,
  agentId: string,
  selector: string | undefined,
  stdout: (message: string) => void,
): Promise<number> {
  if (!selector) {
    throw new McpCliError(
      "invalid_arguments",
      "Usage: letta mcp remove <server>",
    );
  }
  const target = resolveServer(
    await listUnifiedServers(deps, agentId),
    selector,
  );
  if (target.kind === "server") {
    await disconnectAgentMcpServer(
      await getServerClient(deps),
      agentId,
      target.server.id,
    );
  } else {
    if (
      target.config.transport === "http" ||
      target.config.transport === "sse"
    ) {
      await (deps.clearOAuthCredentials ?? clearMcpOAuthCredentials)(
        agentId,
        target.config.name,
        target.config.url,
      );
    }
    await saveLocalServers(
      deps,
      agentId,
      getLocalServers(deps, agentId).filter(
        (config) => config.name !== target.config.name,
      ),
    );
  }
  printJson(stdout, { ok: true, name: serverSummary(target).name });
  return 0;
}

async function runLogin(
  deps: McpSubcommandDependencies,
  agentId: string,
  selector: string | undefined,
  force: boolean,
  stdout: (message: string) => void,
): Promise<number> {
  if (!selector) {
    throw new McpCliError(
      "invalid_arguments",
      "Usage: letta mcp login <server>",
    );
  }
  const target = resolveServer(
    await listUnifiedServers(deps, agentId),
    selector,
  );
  let status = "not_applicable";
  if (target.kind === "server") {
    status = "not_required";
  } else if (
    target.config.transport === "http" ||
    target.config.transport === "sse"
  ) {
    if (hasAuthorizationHeader(target.config)) {
      status = "not_required";
    } else {
      if (force) {
        await (deps.clearOAuthCredentials ?? clearMcpOAuthCredentials)(
          agentId,
          target.config.name,
          target.config.url,
        );
      }
      const connection = await connectConfiguredServer(
        deps,
        agentId,
        target.config,
        true,
      );
      await connection.close();
      status = "authenticated";
    }
  }
  printJson(stdout, { ok: true, name: serverSummary(target).name, status });
  return 0;
}

async function runLogout(
  deps: McpSubcommandDependencies,
  agentId: string,
  selector: string | undefined,
  stdout: (message: string) => void,
): Promise<number> {
  if (!selector) {
    throw new McpCliError(
      "invalid_arguments",
      "Usage: letta mcp logout <server>",
    );
  }
  const target = resolveServer(
    await listUnifiedServers(deps, agentId),
    selector,
  );
  let status = "not_applicable";
  if (
    target.kind === "client" &&
    (target.config.transport === "http" || target.config.transport === "sse") &&
    !hasAuthorizationHeader(target.config)
  ) {
    const removed = await (
      deps.clearOAuthCredentials ?? clearMcpOAuthCredentials
    )(agentId, target.config.name, target.config.url);
    status = removed ? "logged_out" : "not_authenticated";
  }
  printJson(stdout, { ok: true, name: serverSummary(target).name, status });
  return 0;
}

async function runTools(
  deps: McpSubcommandDependencies,
  agentId: string,
  serverSelector: string | undefined,
  stdout: (message: string) => void,
): Promise<number> {
  const catalog = await buildToolCatalog(deps, agentId, serverSelector);
  try {
    printJson(
      stdout,
      catalog.tools.map((tool) => tool.schema),
    );
  } finally {
    await catalog.close();
  }
  return 0;
}

async function runCall(
  parsed: ParsedMcpArgs,
  deps: McpSubcommandDependencies,
  agentId: string,
  stdout: (message: string) => void,
): Promise<number> {
  const toolName = parsed.target;
  if (!toolName) {
    throw new McpCliError(
      "invalid_arguments",
      "Usage: letta mcp call <tool-name> [--args '<json>']",
    );
  }
  const args = await loadMcpToolArgs(
    stringValue(parsed.values.args),
    stringValue(parsed.values["args-file"]),
    deps,
  );
  const catalog = await buildToolCatalog(deps, agentId);
  try {
    const tool = catalog.tools.find(
      (candidate) => candidate.schema.name === toolName,
    );
    if (!tool) {
      throw new McpCliError(
        "tool_not_found",
        `MCP tool '${toolName}' is not available`,
      );
    }
    const result =
      tool.target.kind === "client"
        ? await tool.target.connection.callTool(tool.target.rawName, args)
        : mcpToolResultFromServer(
            await runAgentConnectedMcpTool({
              client: await getServerClient(deps),
              agentId,
              mcpServerId: tool.target.serverId,
              toolId: tool.target.toolId,
              args,
            }),
          );
    printJson(stdout, result);
    return result.isError === true ? 2 : 0;
  } finally {
    await catalog.close();
  }
}

export async function runMcpSubcommand(
  argv: string[],
  deps: McpSubcommandDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  let parsed: ParsedMcpArgs;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    printError(stderr, error);
    return 1;
  }

  if (parsed.values.help || !parsed.action || parsed.action === "help") {
    printMcpUsage(stdout);
    return 0;
  }

  const agentId = resolveMcpAgentId(
    stringValue(parsed.values.agent),
    stringValue(parsed.values["agent-id"]),
    deps.env ?? process.env,
  );
  if (!agentId) {
    printError(
      stderr,
      new McpCliError(
        "agent_id_required",
        "No agent context found",
        "Pass --agent <agent-id> or set LETTA_AGENT_ID.",
      ),
    );
    return 1;
  }

  try {
    await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
    switch (parsed.action) {
      case "list":
        return await runList(deps, agentId, stdout);
      case "get":
        return await runGet(deps, agentId, parsed.target, stdout);
      case "add":
        return await runAdd(parsed, deps, agentId, stdout);
      case "remove":
        return await runRemove(deps, agentId, parsed.target, stdout);
      case "login":
        return await runLogin(
          deps,
          agentId,
          parsed.target,
          parsed.values.force === true,
          stdout,
        );
      case "logout":
        return await runLogout(deps, agentId, parsed.target, stdout);
      case "tools":
      case "list-tools":
      case "list_tools":
        return await runTools(deps, agentId, parsed.target, stdout);
      case "call":
      case "run":
      case "run-tool":
      case "run_tool":
        return await runCall(parsed, deps, agentId, stdout);
      default:
        throw new McpCliError(
          "unknown_command",
          `Unknown mcp command '${parsed.action}'`,
        );
    }
  } catch (error) {
    printError(stderr, error);
    return 1;
  }
}
