import { readFile } from "node:fs/promises";
import { isRecord } from "@/utils/type-guards";

export function printMcpUsage(stdout: (message: string) => void): void {
  stdout(
    `
Usage:
  letta mcp list [--agent <id>]
  letta mcp get <server> [--agent <id>]
  letta mcp add <server> [--agent <id>]
  letta mcp add <name> --transport stdio [--cwd <path>] [--env KEY=VALUE] -- <command> [args...]
  letta mcp add <name> --transport <http|sse> --url <url> [--header "Name: value"] [--auth-env <env>]
  letta mcp remove <server> [--agent <id>]
  letta mcp login <server> [--force] [--agent <id>]
  letta mcp logout <server> [--agent <id>]
  letta mcp tools [server] [--agent <id>]
  letta mcp call <tool-name> [--args '<json>' | --args-file <path|->] [--agent <id>]

Commands:
  list      List MCP servers available to the agent
  get       Print one server's redacted connection configuration
  add       Make an existing server available, or configure a new connection
  remove    Make a server unavailable to the agent
  login     Authenticate an OAuth-protected MCP server
  logout    Remove saved MCP OAuth credentials
  tools     Print complete MCP tool schemas; names are accepted by call
  call      Call one exact tool name and print an MCP CallToolResult

Options:
  --agent <id>       Agent ID. Defaults to LETTA_AGENT_ID or AGENT_ID
  --agent-id <id>    Alias for --agent
  --transport <type> stdio, http, streamable_http, or sse
  --url <url>        HTTP/SSE MCP endpoint
  --cwd <path>       Working directory for a stdio server
  --env KEY=VALUE    Repeatable stdio environment variable
  --header "K: V"    Repeatable HTTP/SSE header
  --auth-env <name>  Build an Authorization bearer header from an environment variable
  --no-verify        Save a new connection without calling tools/list first
  --force            Clear saved OAuth state before login
  --args <json>      JSON object passed to a tool
  --args-file <path> Read tool arguments from a file; use - for stdin
  -h, --help         Show this help

Output is JSON. Server placement and agent/server/tool IDs are internal.
`.trim(),
  );
}

export function resolveMcpAgentId(
  agent?: string,
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (agent || agentId || env.LETTA_AGENT_ID || env.AGENT_ID || "").trim();
}

export async function loadMcpToolArgs(
  inline: string | undefined,
  file: string | undefined,
  deps: {
    readFile?: (path: string) => Promise<string>;
    readStdin?: () => Promise<string>;
  },
): Promise<Record<string, unknown>> {
  if (inline && file)
    throw new Error("Pass either --args or --args-file, not both");
  if (inline) return parseJsonObject(inline, "Invalid --args JSON");
  if (!file) return {};
  const raw =
    file === "-"
      ? await (deps.readStdin ?? readStdin)()
      : await (deps.readFile ?? ((path) => readFile(path, "utf8")))(file);
  return parseJsonObject(raw, `Invalid arguments in ${file}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error(`${label}: expected a JSON object`);
  return parsed;
}
