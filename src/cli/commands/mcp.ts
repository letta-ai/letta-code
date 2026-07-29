// src/cli/commands/mcp.ts
// MCP server command handlers

import type { Buffers, Line } from "@/cli/helpers/accumulator";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import type { McpServerConfig } from "@/mcp-client";
import { replaceClientMcpServers } from "@/mcp-runtime";
import { settingsManager } from "@/settings-manager";

// tiny helper for unique ids
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Helper type for command result
type CommandLine = Extract<Line, { kind: "command" }>;

let activeCommandId: string | null = null;

export function setActiveCommandId(id: string | null): void {
  activeCommandId = id;
}

// Context passed to MCP handlers
export interface McpCommandContext {
  agentId: string;
  buffersRef: { current: Buffers };
  refreshDerived: () => void;
  setCommandRunning: (running: boolean) => void;
}

// Helper to add a command result to buffers
export function addCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): string {
  const cmdId = activeCommandId ?? uid("cmd");
  const existing = buffersRef.current.byId.get(cmdId);
  const nextInput =
    existing && existing.kind === "command" ? existing.input : input;
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input: nextInput,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  if (!buffersRef.current.order.includes(cmdId)) {
    buffersRef.current.order.push(cmdId);
  }
  refreshDerived();
  return cmdId;
}

// Helper to update an existing command result
export function updateCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  cmdId: string,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): void {
  const existing = buffersRef.current.byId.get(cmdId);
  const nextInput =
    existing && existing.kind === "command" ? existing.input : input;
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input: nextInput,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  refreshDerived();
}

// Helper to parse command line arguments respecting quoted strings
function parseCommandArgs(commandStr: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < commandStr.length; i++) {
    const char = commandStr[i];
    if (!char) continue; // Skip if undefined (shouldn't happen but type safety)

    if ((char === '"' || char === "'") && !inQuotes) {
      // Start of quoted string
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      // End of quoted string
      inQuotes = false;
      quoteChar = "";
    } else if (/\s/.test(char) && !inQuotes) {
      // Whitespace outside quotes - end of argument
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      // Regular character or whitespace inside quotes
      current += char;
    }
  }

  // Add final argument if any
  if (current) {
    args.push(current);
  }

  return args;
}

// Parse /mcp add args
interface McpAddArgs {
  transport: "http" | "sse" | "stdio";
  name: string;
  url: string | null;
  command: string | null;
  args: string[];
  headers: Record<string, string>;
  authToken: string | null;
}

function parseMcpAddArgs(parts: string[]): McpAddArgs | null {
  // Expected format: add --transport <type> <name> <url/command> [--header "key: value"]
  let transport: "http" | "sse" | "stdio" | null = null;
  let name: string | null = null;
  let url: string | null = null;
  let command: string | null = null;
  const args: string[] = [];
  const headers: Record<string, string> = {};
  let authToken: string | null = null;

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];

    if (part === "--transport" || part === "-t") {
      i++;
      const transportValue = parts[i]?.toLowerCase();
      if (transportValue === "http" || transportValue === "streamable_http") {
        transport = "http";
      } else if (transportValue === "sse") {
        transport = "sse";
      } else if (transportValue === "stdio") {
        transport = "stdio";
      }
      i++;
    } else if (part === "--header" || part === "-h") {
      i++;
      const headerValue = parts[i];
      if (headerValue) {
        // Parse "key: value" or "key=value"
        const colonMatch = headerValue.match(/^([^:]+):\s*(.+)$/);
        const equalsMatch = headerValue.match(/^([^=]+)=(.+)$/);
        if (colonMatch?.[1] && colonMatch[2]) {
          headers[colonMatch[1].trim()] = colonMatch[2].trim();
        } else if (equalsMatch?.[1] && equalsMatch[2]) {
          headers[equalsMatch[1].trim()] = equalsMatch[2].trim();
        }
      }
      i++;
    } else if (part === "--auth" || part === "-a") {
      i++;
      authToken = parts[i] || null;
      i++;
    } else if (!name) {
      name = part || null;
      i++;
    } else if (!url && transport !== "stdio") {
      url = part || null;
      i++;
    } else if (!command && transport === "stdio") {
      command = part || null;
      i++;
    } else if (transport === "stdio" && part) {
      // Collect remaining parts as args for stdio
      args.push(part);
      i++;
    } else {
      i++;
    }
  }

  if (!transport || !name) {
    return null;
  }

  if (transport !== "stdio" && !url) {
    return null;
  }

  if (transport === "stdio" && !command) {
    return null;
  }

  return {
    transport,
    name,
    url: url || null,
    command: command || null,
    args,
    headers,
    authToken: authToken || null,
  };
}

// /mcp add --transport <type> <name> <url/command> [options]
export async function handleMcpAdd(
  ctx: McpCommandContext,
  msg: string,
  commandStr: string,
): Promise<void> {
  // Parse the full command string respecting quotes
  const parts = parseCommandArgs(commandStr);
  const args = parseMcpAddArgs(parts);

  if (!args) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      'Usage: /mcp add --transport <http|sse|stdio> <name> <url|command> [--header "key: value"] [--auth token]\n\nExamples:\n  /mcp add --transport http notion https://mcp.notion.com/mcp\n  /mcp add --transport http secure-api https://api.example.com/mcp --header "Authorization: Bearer token"',
      false,
    );
    return;
  }

  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Creating MCP server "${args.name}"...`,
    false,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    const existing = settingsManager.getMcpServers(ctx.agentId);
    if (existing.some((server) => server.name === args.name)) {
      throw new Error(`MCP server "${args.name}" already exists`);
    }

    const headers = {
      ...args.headers,
      ...(args.authToken ? { Authorization: `Bearer ${args.authToken}` } : {}),
    };
    let config: McpServerConfig;
    if (args.transport === "stdio") {
      if (!args.command) throw new Error("Command is required for stdio");
      config = {
        name: args.name,
        transport: "stdio",
        command: args.command,
        args: args.args,
        cwd: process.cwd(),
      };
    } else {
      if (!args.url) throw new Error("URL is required for HTTP/SSE");
      config = {
        name: args.name,
        transport: args.transport,
        url: args.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    }

    const configs = [...existing, config];
    settingsManager.setMcpServers(ctx.agentId, configs);
    await settingsManager.flush();
    const states = await replaceClientMcpServers(ctx.agentId, configs, {
      interactiveOAuth: true,
      onStatus: (status) =>
        updateCommandResult(
          ctx.buffersRef,
          ctx.refreshDerived,
          cmdId,
          msg,
          status,
          false,
          "running",
        ),
    });
    const state = states.find(
      (candidate) => candidate.config.name === args.name,
    );
    if (!state || state.status === "failed") {
      throw new Error(state?.error ?? "MCP server failed to connect");
    }

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Added MCP server "${args.name}" to this agent (${args.transport})\nLoaded ${state.tools.length} tool${state.tools.length === 1 ? "" : "s"}`,
      true,
    );
  } catch (error) {
    const errorDetails = formatErrorDetails(error, "");
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Failed: ${errorDetails}`,
      false,
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

// Show usage help
export function handleMcpUsage(ctx: McpCommandContext, msg: string): void {
  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Usage: /mcp [subcommand ...]\n" +
      "  /mcp                  - Open client-local MCP manager\n" +
      "  /mcp add ...          - Add a client-local server (OAuth opens automatically)\n\n" +
      "Examples:\n" +
      "  /mcp add --transport stdio filesystem npx -y @modelcontextprotocol/server-filesystem .\n" +
      "  /mcp add --transport http notion https://mcp.notion.com/mcp",
    false,
  );
}
