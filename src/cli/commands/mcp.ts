// src/cli/commands/mcp.ts
// MCP server command handlers

import type {
  CreateStreamableHTTPMcpServer,
  CreateSseMcpServer,
  CreateStdioMcpServer,
} from "@letta-ai/letta-client/resources/mcp-servers/mcp-servers";
import { getClient } from "../../agent/client";
import type { Buffers, Line } from "../helpers/accumulator";
import { formatErrorDetails } from "../helpers/errorFormatter";

// tiny helper for unique ids
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Helper type for command result
type CommandLine = Extract<Line, { kind: "command" }>;

// Context passed to MCP handlers
export interface McpCommandContext {
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
  const cmdId = uid("cmd");
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  buffersRef.current.order.push(cmdId);
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
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  refreshDerived();
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
  let args: string[] = [];
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
        if (colonMatch && colonMatch[1] && colonMatch[2]) {
          headers[colonMatch[1].trim()] = colonMatch[2].trim();
        } else if (equalsMatch && equalsMatch[1] && equalsMatch[2]) {
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
    authToken: authToken || null 
  };
}

// /mcp add --transport <type> <name> <url/command> [options]
export async function handleMcpAdd(
  ctx: McpCommandContext,
  msg: string,
  parts: string[],
): Promise<void> {
  const args = parseMcpAddArgs(parts);

  if (!args) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /mcp add --transport <http|sse|stdio> <name> <url|command> [--header \"key: value\"] [--auth token]\n\nExamples:\n  /mcp add --transport http notion https://mcp.notion.com/mcp\n  /mcp add --transport http secure-api https://api.example.com/mcp --header \"Authorization: Bearer token\"",
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
    const client = await getClient();

    let config:
      | CreateStreamableHTTPMcpServer
      | CreateSseMcpServer
      | CreateStdioMcpServer;

    if (args.transport === "http") {
      if (!args.url) {
        throw new Error("URL is required for HTTP transport");
      }
      config = {
        mcp_server_type: "streamable_http",
        server_url: args.url,
        auth_token: args.authToken,
        custom_headers: Object.keys(args.headers).length > 0 ? args.headers : null,
      };
    } else if (args.transport === "sse") {
      if (!args.url) {
        throw new Error("URL is required for SSE transport");
      }
      config = {
        mcp_server_type: "sse",
        server_url: args.url,
        auth_token: args.authToken,
        custom_headers: Object.keys(args.headers).length > 0 ? args.headers : null,
      };
    } else {
      // stdio
      if (!args.command) {
        throw new Error("Command is required for stdio transport");
      }
      config = {
        mcp_server_type: "stdio",
        command: args.command,
        args: args.args,
      };
    }

    const server = await client.mcpServers.create({
      server_name: args.name,
      config,
    });

    if (!server.id) {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" but server ID not available`,
        false,
      );
      return;
    }

    // Auto-refresh to fetch tools from the MCP server
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Created MCP server "${args.name}" (${server.mcp_server_type})\nID: ${server.id}\nFetching tools from server...`,
      false,
      "running",
    );

    try {
      await client.mcpServers.refresh(server.id);
      
      // Get tool count
      const tools = await client.mcpServers.tools.list(server.id);
      
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" (${server.mcp_server_type})\nID: ${server.id}\nLoaded ${tools.length} tool${tools.length === 1 ? "" : "s"} from server`,
        true,
      );
    } catch (refreshErr) {
      // If refresh fails, still show success but warn about tools
      const errorMsg = refreshErr instanceof Error ? refreshErr.message : "Unknown error";
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" (${server.mcp_server_type})\nID: ${server.id}\nWarning: Could not fetch tools - ${errorMsg}\nUse /mcp and press R to refresh manually.`,
        true,
      );
    }
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
    "Usage: /mcp [add ...]\n  /mcp - list MCP servers\n  /mcp add --transport <http|sse|stdio> <name> <url|command> [...] - add a new server\n\nExamples:\n  /mcp add --transport http notion https://mcp.notion.com/mcp\n  /mcp add --transport http api https://api.example.com --header \"Authorization: Bearer token\"",
    false,
  );
}
