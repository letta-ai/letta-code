import { parseArgs } from "node:util";
import { getBackend } from "@/backend";
import { getClient as getDefaultClient } from "@/backend/api/client";
import {
  listUnifiedMcpServers,
  searchUnifiedMcpTools,
  type UnifiedMcpClient,
  type UnifiedMcpServer,
} from "@/backend/api/unified-mcp";
import type { connectMcpServer, McpServerConfig } from "@/mcp-client";
import type { createMcpOAuthSession } from "@/mcp-oauth";
import {
  buildMcpToolCatalog,
  callMcpCatalogTool,
  type McpToolCatalog,
} from "@/mcp-tool-catalog";
import { getMcpScopeAgentId, type ParentAgentLookup } from "@/mcp-scope";
import { settingsManager } from "@/settings-manager";
import {
  loadMcpToolArgs,
  McpCliError,
  type McpOutput,
  printMcpError,
  printMcpUsage,
  resolveMcpAgentId,
  writeMcpStderr,
  writeMcpStdout,
} from "./mcp-io";
import {
  mergeMcpSearchResults,
  runMcpSearch,
  searchLocalMcpTools,
} from "./mcp-search";

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

export interface McpSubcommandDependencies {
  initializeSettings?: () => Promise<void>;
  lookupParentAgent?: ParentAgentLookup;
  getLocalServers?: (agentId: string) => McpServerConfig[];
  connectLocalServer?: typeof connectMcpServer;
  createOAuthSession?: typeof createMcpOAuthSession;
  getClient?: () => Promise<UnifiedMcpClient>;
  isServerMcpAvailable?: () => boolean;
  isHostedLettaCloud?: () => boolean;
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  stdout?: McpOutput;
  stderr?: McpOutput;
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

async function printJson(stdout: McpOutput, value: unknown): Promise<void> {
  await stdout(JSON.stringify(value, null, 2));
}

async function runList(
  deps: McpSubcommandDependencies,
  agentId: string,
  stdout: McpOutput,
): Promise<number> {
  const servers = await listUnifiedServers(deps, agentId);
  await printJson(stdout, servers.map(serverSummary));
  return 0;
}

async function runGet(
  deps: McpSubcommandDependencies,
  agentId: string,
  selector: string | undefined,
  stdout: McpOutput,
): Promise<number> {
  if (!selector) {
    throw new McpCliError("invalid_arguments", "Usage: letta mcp get <server>");
  }
  const server = resolveServer(
    await listUnifiedServers(deps, agentId),
    selector,
  );
  await printJson(stdout, serverDetails(server));
  return 0;
}

async function runTools(
  deps: McpSubcommandDependencies,
  agentId: string,
  serverSelector: string | undefined,
  full: boolean,
  stdout: McpOutput,
): Promise<number> {
  const catalog = await buildMcpToolCatalog(deps, agentId, { serverSelector });
  try {
    await printJson(
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
  stdout: McpOutput,
): Promise<number> {
  if (!toolName) {
    throw new McpCliError(
      "invalid_arguments",
      "Usage: letta mcp schema <tool-name>",
    );
  }
  const catalog = await buildMcpToolCatalog(deps, agentId, { toolName });
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
    await printJson(stdout, tool.schema);
    return 0;
  } finally {
    await catalog.close();
  }
}

async function runSearch(
  parsed: ParsedMcpArgs,
  deps: McpSubcommandDependencies,
  agentId: string,
  stdout: McpOutput,
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
        const catalog = await buildMcpToolCatalog(deps, agentId);
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
      const catalogPromise = buildMcpToolCatalog(deps, agentId, {
        ...(includeLocal ? {} : { targetKind: "server" }),
      });
      let catalog: McpToolCatalog | undefined;
      try {
        const [searchResults, resolvedCatalog] = await Promise.all([
          searchPromise,
          catalogPromise,
        ]);
        catalog = resolvedCatalog;
        const serverResults = searchResults.flatMap((result) => {
          const callable = resolvedCatalog.tools.find(
            (tool) =>
              tool.target.kind === "server" &&
              tool.target.toolId === result.toolId,
          );
          if (!callable) {
            // The server-side index still contains tools from servers the
            // catalog excluded (stdio-type cloud servers on hosted Letta
            // Cloud); drop those instead of surfacing uncallable results.
            if (resolvedCatalog.excludedHostedStdioServers) {
              return [];
            }
            throw new Error(
              `MCP search returned unavailable tool '${result.toolId}'`,
            );
          }
          return [
            {
              tool:
                result.jsonSchema === null
                  ? null
                  : { ...result.jsonSchema, name: callable.schema.name },
              score: result.score,
            },
          ];
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
  stdout: McpOutput,
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
  const catalog = await buildMcpToolCatalog(deps, agentId, { toolName });
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
    const result = await callMcpCatalogTool(tool, agentId, args, deps);
    await printJson(stdout, result);
    return result.isError === true ? 2 : 0;
  } finally {
    await catalog.close();
  }
}

export async function runMcpSubcommand(
  argv: string[],
  deps: McpSubcommandDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? writeMcpStdout;
  const stderr = deps.stderr ?? writeMcpStderr;
  let parsed: ParsedMcpArgs;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    await printMcpError(stderr, error);
    return 1;
  }

  if (parsed.values.help || !parsed.action || parsed.action === "help") {
    await printMcpUsage(stdout);
    return 0;
  }

  let agentId = resolveMcpAgentId(
    stringValue(parsed.values.agent),
    stringValue(parsed.values["agent-id"]),
    deps.env ?? process.env,
  );
  if (!agentId) {
    await printMcpError(
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
    if (!parsed.values.agent && !parsed.values["agent-id"]) {
      agentId = await getMcpScopeAgentId(
        agentId,
        deps.env ?? process.env,
        deps.lookupParentAgent,
      );
    }
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
    await printMcpError(stderr, error);
    return 1;
  }
}
