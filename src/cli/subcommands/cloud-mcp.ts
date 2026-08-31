import { parseArgs } from "node:util";
import { getBackend } from "@/backend";
import { getClient as getDefaultClient } from "@/backend/api/client";
import {
  type AgentConnectedMcpServer,
  type AgentConnectedMcpTool,
  listAgentConnectedMcpServers,
  listAgentConnectedMcpTools,
  runAgentConnectedMcpTool,
  type ServerMcpClient,
} from "@/backend/api/mcp-servers";
import { settingsManager } from "@/settings-manager";
import { isRecord } from "@/utils/type-guards";

export interface CloudMcpSubcommandDependencies {
  initializeSettings?: () => Promise<void>;
  getClient?: () => Promise<ServerMcpClient>;
  isServerSideMcpAvailable?: () => boolean;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

interface CloudMcpCommandResult {
  agent_id: string;
}

interface CloudMcpListResult extends CloudMcpCommandResult {
  servers: Array<
    Pick<AgentConnectedMcpServer, "id" | "serverName" | "serverType" | "target">
  >;
}

interface CloudMcpToolsResult extends CloudMcpCommandResult {
  mcp_server_id: string;
  tools: Array<Pick<AgentConnectedMcpTool, "id" | "name" | "description">>;
}

interface CloudMcpRunResult extends CloudMcpCommandResult {
  mcp_server_id: string;
  tool_id: string;
  result: Awaited<ReturnType<typeof runAgentConnectedMcpTool>>;
}

function printUsage(stdout: (message: string) => void = console.log): void {
  stdout(
    `
Usage:
  letta cloud-mcp list [--agent <id>]
  letta cloud-mcp tools <mcp-server-id> [--agent <id>]
  letta cloud-mcp run <mcp-server-id> <tool-id> [--args '<json>'] [--agent <id>]

Actions:
  list      List MCP servers connected to the agent
  tools     List registered tools for one connected MCP server
  run       Run one registered MCP tool through the agent-scoped server route

Aliases:
  list-servers, list_servers  Alias for list
  list-tools, list_tools      Alias for tools
  call, run-tool, run_tool     Alias for run

Options:
  --agent <id>      Agent ID. Defaults to LETTA_AGENT_ID or AGENT_ID
  --agent-id <id>   Alias for --agent
  --args '<json>'   JSON object passed as MCP tool arguments for run
  -h, --help        Show this help

Notes:
  - Output is JSON only.
  - Requires a signed-in Letta Cloud agent with server-side MCP support.
  - Uses CLI auth; override with LETTA_API_KEY/LETTA_BASE_URL if needed.
`.trim(),
  );
}

function parseCloudMcpArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      agent: { type: "string" },
      "agent-id": { type: "string" },
      args: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function resolveCloudMcpAgentId(
  agent?: string,
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (agent || agentId || env.LETTA_AGENT_ID || env.AGENT_ID || "").trim();
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  const raw = stringValue(value);
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --args JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Invalid --args JSON: expected a JSON object");
  }

  return parsed;
}

function printJson(
  stdout: (message: string) => void,
  result: CloudMcpListResult | CloudMcpToolsResult | CloudMcpRunResult,
): void {
  stdout(JSON.stringify(result, null, 2));
}

async function defaultGetClient(): Promise<ServerMcpClient> {
  const client: ServerMcpClient = await getDefaultClient();
  return client;
}

export async function runCloudMcpSubcommand(
  argv: string[],
  deps: CloudMcpSubcommandDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;

  let parsed: ReturnType<typeof parseCloudMcpArgs>;
  try {
    parsed = parseCloudMcpArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`Error: ${message}`);
    printUsage(stdout);
    return 1;
  }

  const [action, mcpServerId, toolId] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage(stdout);
    return 0;
  }

  const isAvailable =
    deps.isServerSideMcpAvailable ??
    (() => getBackend().capabilities.serverSideToolManagement);
  if (!isAvailable()) {
    stderr(
      "Server-side MCP requires a signed-in Letta Cloud agent; the local backend does not support it.",
    );
    return 1;
  }

  const agentId = resolveCloudMcpAgentId(
    stringValue(parsed.values.agent),
    stringValue(parsed.values["agent-id"]),
  );
  if (!agentId) {
    stderr(
      "Agent id required: pass --agent <id> or set LETTA_AGENT_ID/AGENT_ID.",
    );
    return 1;
  }

  await (deps.initializeSettings ?? (() => settingsManager.initialize()))();
  const client = await (deps.getClient ?? defaultGetClient)();

  try {
    if (
      action === "list" ||
      action === "list-servers" ||
      action === "list_servers"
    ) {
      const servers = await listAgentConnectedMcpServers(client, agentId);
      printJson(stdout, {
        agent_id: agentId,
        servers: servers.map(({ id, serverName, serverType, target }) => ({
          id,
          serverName,
          serverType,
          target,
        })),
      });
      return 0;
    }

    if (
      action === "tools" ||
      action === "list-tools" ||
      action === "list_tools"
    ) {
      if (!mcpServerId) {
        stderr("Usage: letta cloud-mcp tools <mcp-server-id> [--agent <id>]");
        return 1;
      }
      const tools = await listAgentConnectedMcpTools(
        client,
        agentId,
        mcpServerId,
      );
      printJson(stdout, {
        agent_id: agentId,
        mcp_server_id: mcpServerId,
        tools: tools.map(({ id, name, description }) => ({
          id,
          name,
          description,
        })),
      });
      return 0;
    }

    if (
      action === "run" ||
      action === "call" ||
      action === "run-tool" ||
      action === "run_tool"
    ) {
      if (!mcpServerId || !toolId) {
        stderr(
          "Usage: letta cloud-mcp run <mcp-server-id> <tool-id> [--args '<json>'] [--agent <id>]",
        );
        return 1;
      }
      printJson(stdout, {
        agent_id: agentId,
        mcp_server_id: mcpServerId,
        tool_id: toolId,
        result: await runAgentConnectedMcpTool({
          client,
          agentId,
          mcpServerId,
          toolId,
          args: parseToolArgs(parsed.values.args),
        }),
      });
      return 0;
    }

    stderr(`Unknown cloud-mcp action: ${action}`);
    printUsage(stdout);
    return 1;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
