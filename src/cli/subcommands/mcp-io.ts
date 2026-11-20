import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { readStdin } from "@/utils/stdin";
import { isRecord } from "@/utils/type-guards";

export type McpOutput = (message: string) => unknown;

function writeMcpOutput(
  stream: NodeJS.WriteStream,
  message: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const onError = (error: unknown) => fail(error);
    stream.once("error", onError);

    try {
      stream.write(`${message}\n`, (error) => {
        if (error) {
          // Keep onError installed because Node can emit the same write failure
          // after invoking this callback.
          fail(error);
          return;
        }
        if (settled) return;
        settled = true;
        stream.off("error", onError);
        resolve();
      });
    } catch (error) {
      stream.off("error", onError);
      fail(error);
    }
  });
}

export function writeMcpStdout(message: string): Promise<void> {
  return writeMcpOutput(process.stdout, message);
}

export function writeMcpStderr(message: string): Promise<void> {
  return writeMcpOutput(process.stderr, message);
}

export class McpCliError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "McpCliError";
    this.code = code;
    this.hint = hint;
  }
}

export async function printMcpError(
  stderr: McpOutput,
  error: unknown,
): Promise<void> {
  const normalized =
    error instanceof McpCliError
      ? error
      : new McpCliError(
          "mcp_error",
          error instanceof Error ? error.message : String(error),
        );
  await stderr(
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

export async function printMcpUsage(stdout: McpOutput): Promise<void> {
  await stdout(
    `
Usage:
  letta mcp list [--agent <id>]
  letta mcp get <server> [--agent <id>]
  letta mcp tools [server] [--full] [--agent <id>]
  letta mcp schema <tool-name> [--agent <id>]
  letta mcp search <query> [--mode <hybrid|vector|fts>] [--limit <n>] [--agent <id>]
  letta mcp call <tool-name> [--args '<json>' | --args-file <path|->] [--agent <id>]
  letta mcp events <server> [--agent <id>]
  letta mcp watch <server> <event> [--args '<json>' | --args-file <path|->]
  letta mcp connect <service> [--server-url <url>] [--client-name <name>] [--agent <id>]

Commands:
  list      List MCP servers available to the agent
  get       Print one server's redacted connection configuration
  tools     List tool names and descriptions; names are accepted by call
  schema    Print one tool's complete schema
  search    Search tools available to the agent
  call      Call one exact tool name and print an MCP CallToolResult
  events    List MCP event types on a configured server
  watch     Subscribe to an event and stream JSON lines until stopped
  connect   Authorize comfy or datadog in this computer's browser and save
            the connection to the Cloud agent

Options:
  --webhook-url <url> HTTPS callback forwarding to this watch (selects webhook delivery)
  --webhook-port <n>  Local loopback receiver port (default: 8765)
  --agent <id>       Agent ID. Defaults to LETTA_AGENT_ID or AGENT_ID
  --agent-id <id>    Alias for --agent
  --full             Include complete schemas in tools output
  --mode <mode>      Search mode: hybrid (default), vector, or fts
  --limit <n>        Search result limit from 1 to 100 (default: 5)
  --args <json>      JSON object passed to a tool
  --args-file <path> Read tool arguments from a file; use - for stdin
  --server-url <url> MCP server for connect, e.g. a Datadog site's URL
                     (default: the service's first supported URL; non-US1
                     Datadog orgs can pass https://mcp.<site>/v1/mcp)
  --client-name <name>
                     Application name shown on the provider's consent screen
                     during connect, 1 to 64 characters (default: Letta Code)
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

export interface ParsedMcpArgs {
  action?: string;
  target?: string;
  event?: string;
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
      "webhook-url": { type: "string" },
      "webhook-port": { type: "string" },
      args: { type: "string" },
      "args-file": { type: "string" },
      "server-url": { type: "string" },
      "client-name": { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });
}

export function parseMcpCommandLine(argv: string[]): ParsedMcpArgs {
  const parsed = parseMcpArgs(argv);
  const [action, target, ...extra] = parsed.positionals;
  const event = action === "watch" ? extra.shift() : undefined;
  if (extra.length > 0) {
    throw new McpCliError(
      "invalid_arguments",
      `Unexpected positional arguments: ${extra.join(" ")}`,
    );
  }
  return { action, target, event, values: parsed.values };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
