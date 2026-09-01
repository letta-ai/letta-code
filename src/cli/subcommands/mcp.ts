import { parseArgs } from "node:util";
import { getBackend } from "@/backend";
import { getClient as getDefaultClient } from "@/backend/api/client";
import {
  listUnifiedMcpServers,
  listUnifiedMcpTools,
  runUnifiedMcpTool,
  searchUnifiedMcpTools,
  type UnifiedMcpClient,
  type UnifiedMcpRunResult,
  type UnifiedMcpServer,
} from "@/backend/api/unified-mcp";
import {
  type ConnectedMcpServer,
  connectMcpServer,
  type McpOAuthConnection,
  type McpServerConfig,
  type McpToolDefinition,
  type McpToolResult,
} from "@/mcp-client";
import { createMcpOAuthSession } from "@/mcp-oauth";
import { formatClientMcpToolName } from "@/mcp-runtime";
import { settingsManager } from "@/settings-manager";
import { isRecord } from "@/utils/type-guards";
import {
  loadMcpToolArgs,
  McpCliError,
  printMcpError,
  printMcpUsage,
  resolveMcpAgentId,
} from "./mcp-io";
import {
  mergeMcpSearchResults,
  runMcpSearch,
  searchLocalMcpTools,
} from "./mcp-search";
import {
  assignMcpServerAliases,
  formatServerMcpToolName,
  uniqueMcpName,
} from "./mcp-tool-names";

type McpTransport = "stdio" | "streamable_http" | "sse" | "unknown";

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
    })
  | (McpServerSummary & { transport: "unknown" });

type ServerTarget =
  | { kind: "client"; config: McpServerConfig }
  | { kind: "server"; server: UnifiedMcpServer };

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
}

interface ToolCatalog {
  tools: CatalogTool[];
  close(): Promise<void>;
}

export interface McpSubcommandDependencies {
  initializeSettings?: () => Promise<void>;
  getLocalServers?: (agentId: string) => McpServerConfig[];
  connectLocalServer?: typeof connectMcpServer;
  createOAuthSession?: typeof createMcpOAuthSession;
  getClient?: () => Promise<UnifiedMcpClient>;
  isServerMcpAvailable?: () => boolean;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

interface ParsedMcpArgs {
  action?: string;
  target?: string;
  values: ReturnType<typeof parseMcpArgs>["values"];
}

function parseMcpArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      agent: { type: "string" },
      "agent-id": { type: "string" },
      mode: { type: "string" },
      limit: { type: "string" },
      full: { type: "boolean" },
      args: { type: "string" },
      "args-file": { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
}

function parseCommandLine(argv: string[]): ParsedMcpArgs {
  const parsed = parseMcpArgs(argv);
  const [action, target, ...extra] = parsed.positionals;
  if (extra.length > 0) {
    throw new McpCliError(
      "invalid_arguments",
      `Unexpected positional arguments: ${extra.join(" ")}`,
    );
  }
  return { action, target, values: parsed.values };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
): Promise<UnifiedMcpClient> {
  if (deps.getClient) return deps.getClient();
  return (await getDefaultClient()) as UnifiedMcpClient;
}

function localTransport(config: McpServerConfig): McpTransport {
  if (config.transport === "http") return "streamable_http";
  return config.transport ?? "stdio";
}

function serverTransport(server: UnifiedMcpServer): McpTransport {
  if (server.serverType === "streamable_http") return "streamable_http";
  if (server.serverType === "sse") return "sse";
  if (server.serverType === "stdio") return "stdio";
  return "unknown";
}

function serverSummary(target: ServerTarget): McpServerSummary {
  return target.kind === "client"
    ? { name: target.config.name, transport: localTransport(target.config) }
    : {
        name: target.server.serverName,
        transport: serverTransport(target.server),
      };
}

const SENSITIVE_NAME = /token|key|secret|password|signature|credential|auth/i;

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_NAME.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

/** Redact values that follow (or are inline with) sensitive-named flags. */
function redactArgs(args: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    if (arg.startsWith("-")) {
      const equalsIndex = arg.indexOf("=");
      const flagName = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
      if (SENSITIVE_NAME.test(flagName)) {
        if (equalsIndex === -1) {
          redactNext = true;
          redacted.push(arg);
        } else {
          redacted.push(`${flagName}=[REDACTED]`);
        }
        continue;
      }
    }
    redacted.push(arg);
  }
  return redacted;
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
      args: redactArgs(config.args ?? []),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      env: redactValues(config.env),
    };
  }

  const server = target.server;
  if (server.serverType === "unknown") {
    return { name: server.serverName, transport: "unknown" };
  }
  if (server.serverType === "stdio") {
    return {
      name: server.serverName,
      transport: "stdio",
      command: server.command ?? server.target.split(" ")[0] ?? "",
      args: redactArgs(server.args ?? []),
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
  const connected = await listUnifiedMcpServers(client, agentId);
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

function serverKey(target: ServerTarget): string {
  return target.kind === "client"
    ? `client:${target.config.name}`
    : `server:${target.server.id}`;
}

function serverName(target: ServerTarget): string {
  return target.kind === "client"
    ? target.config.name
    : target.server.serverName;
}

async function buildToolCatalog(
  deps: McpSubcommandDependencies,
  agentId: string,
  options: {
    serverSelector?: string;
    toolName?: string;
    targetKind?: ServerTarget["kind"];
  } = {},
): Promise<ToolCatalog> {
  const servers = await listUnifiedServers(deps, agentId);
  const aliases = assignMcpServerAliases(
    servers.map((target) => ({
      key: serverKey(target),
      name: serverName(target),
      kind: target.kind,
    })),
  );
  let activeServers = options.targetKind
    ? servers.filter((target) => target.kind === options.targetKind)
    : servers;
  if (options.serverSelector) {
    const selectedKey = serverKey(
      resolveServer(servers, options.serverSelector),
    );
    activeServers = servers.filter(
      (target) => serverKey(target) === selectedKey,
    );
  } else if (options.toolName) {
    activeServers = servers.filter((target) => {
      const alias = aliases.get(serverKey(target));
      return (
        alias !== undefined &&
        options.toolName?.startsWith(`mcp__${alias}__`) === true
      );
    });
  }
  const catalog: CatalogTool[] = [];
  const connections: ConnectedMcpServer[] = [];
  const usedNames = new Set<string>();

  try {
    const serverTargets = activeServers.filter(
      (target): target is Extract<ServerTarget, { kind: "server" }> =>
        target.kind === "server",
    );
    if (serverTargets.length > 0) {
      const client = await getServerClient(deps);
      const toolLists = await Promise.all(
        serverTargets.map(async ({ server }) => ({
          server,
          tools: await listUnifiedMcpTools(client, agentId, server.id),
        })),
      );
      for (const { server, tools } of toolLists) {
        const alias = aliases.get(`server:${server.id}`);
        if (!alias) throw new Error("MCP server alias was not assigned");
        for (const tool of [...tools].sort((left, right) =>
          left.id.localeCompare(right.id),
        )) {
          const name = uniqueMcpName(
            formatServerMcpToolName(server.serverName, alias, tool.name),
            usedNames,
          );
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
          });
        }
      }
    }

    const clientTargets = activeServers.filter(
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
      const alias = aliases.get(`client:${config.name}`);
      if (!alias) throw new Error("MCP server alias was not assigned");
      for (const tool of connection.tools) {
        const name = uniqueMcpName(
          formatClientMcpToolName(alias, tool.name),
          usedNames,
        );
        catalog.push({
          schema: { ...tool, name },
          target: { kind: "client", connection, rawName: tool.name },
        });
      }
    }

    return {
      tools: catalog,
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

function mcpToolResultFromServer(result: UnifiedMcpRunResult): McpToolResult {
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

async function runTools(
  deps: McpSubcommandDependencies,
  agentId: string,
  serverSelector: string | undefined,
  full: boolean,
  stdout: (message: string) => void,
): Promise<number> {
  const catalog = await buildToolCatalog(deps, agentId, { serverSelector });
  try {
    printJson(
      stdout,
      catalog.tools.map((tool) =>
        full
          ? tool.schema
          : {
              name: tool.schema.name,
              ...(tool.schema.title ? { title: tool.schema.title } : {}),
              ...(tool.schema.description
                ? { description: tool.schema.description }
                : {}),
            },
      ),
    );
  } finally {
    await catalog.close();
  }
  return 0;
}

async function runSchema(
  deps: McpSubcommandDependencies,
  agentId: string,
  toolName: string | undefined,
  stdout: (message: string) => void,
): Promise<number> {
  if (!toolName) {
    throw new McpCliError(
      "invalid_arguments",
      "Usage: letta mcp schema <tool-name>",
    );
  }
  const catalog = await buildToolCatalog(deps, agentId, { toolName });
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
    printJson(stdout, tool.schema);
    return 0;
  } finally {
    await catalog.close();
  }
}

async function runSearch(
  parsed: ParsedMcpArgs,
  deps: McpSubcommandDependencies,
  agentId: string,
  stdout: (message: string) => void,
): Promise<number> {
  const serverSearchAvailable = serverMcpAvailable(deps);
  const hasClientLocalServers = getLocalServers(deps, agentId).length > 0;
  return runMcpSearch({
    query: parsed.target,
    mode: stringValue(parsed.values.mode),
    limit: stringValue(parsed.values.limit),
    stdout,
    searchTools: async (request) => {
      if (!serverSearchAvailable) {
        if (request.searchMode === "vector") {
          return searchLocalMcpTools({ tools: [], ...request });
        }
        const catalog = await buildToolCatalog(deps, agentId);
        try {
          return searchLocalMcpTools({
            tools: catalog.tools.map((tool) => tool.schema),
            ...request,
          });
        } finally {
          await catalog.close();
        }
      }

      const includeLocal =
        hasClientLocalServers && request.searchMode !== "vector";
      const searchPromise = searchUnifiedMcpTools({
        client: await getServerClient(deps),
        agentId,
        ...request,
      });
      const catalogPromise = buildToolCatalog(deps, agentId, {
        ...(includeLocal ? {} : { targetKind: "server" }),
      });
      let catalog: ToolCatalog | undefined;
      try {
        const [searchResults, resolvedCatalog] = await Promise.all([
          searchPromise,
          catalogPromise,
        ]);
        catalog = resolvedCatalog;
        const serverResults = searchResults.map((result) => {
          const callable = resolvedCatalog.tools.find(
            (tool) =>
              tool.target.kind === "server" &&
              tool.target.toolId === result.toolId,
          );
          if (!callable) {
            throw new Error(
              `MCP search returned unavailable tool '${result.toolId}'`,
            );
          }
          return {
            tool:
              result.jsonSchema === null
                ? null
                : { ...result.jsonSchema, name: callable.schema.name },
            score: result.score,
          };
        });
        if (!includeLocal) return serverResults;
        const localResults = searchLocalMcpTools({
          tools: resolvedCatalog.tools
            .filter((tool) => tool.target.kind === "client")
            .map((tool) => tool.schema),
          ...request,
        });
        return mergeMcpSearchResults(
          serverResults,
          localResults,
          request.limit,
        );
      } finally {
        const catalogToClose =
          catalog ?? (await catalogPromise.catch(() => undefined));
        await catalogToClose?.close();
      }
    },
  });
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
  const catalog = await buildToolCatalog(deps, agentId, { toolName });
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
            await runUnifiedMcpTool({
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
    printMcpError(stderr, error);
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
    printMcpError(
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
      case "tools":
      case "list-tools":
      case "list_tools":
        return await runTools(
          deps,
          agentId,
          parsed.target,
          parsed.values.full === true,
          stdout,
        );
      case "schema":
        return await runSchema(deps, agentId, parsed.target, stdout);
      case "search":
        return await runSearch(parsed, deps, agentId, stdout);
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
    printMcpError(stderr, error);
    return 1;
  }
}
