// src/cli/commands/mcp.ts
// MCP server command handlers
//
// Supports three transport types:
// - HTTP/Streamable HTTP: Server runs remotely, tools execute server-side
// - SSE: Server runs remotely, tools execute server-side  
// - Stdio: Server runs locally as subprocess, tools execute client-side (NEW)

import type {
  CreateSseMcpServer,
  CreateStdioMcpServer,
  CreateStreamableHTTPMcpServer,
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
      'Usage: /mcp add --transport <http|sse|stdio> <name> <url|command> [--header "key: value"] [--auth token]\n\nExamples:\n  /mcp add --transport http notion https://mcp.notion.com/mcp\n  /mcp add --transport sse my-sse-server https://example.com/sse\n  /mcp add --transport stdio filesystem npx @modelcontextprotocol/server-filesystem /path/to/dir\n  /mcp add --transport http secure-api https://api.example.com/mcp --header "Authorization: Bearer token"\n\nNote: stdio servers run locally and are managed client-side.',
      false,
    );
    return;
  }

  // Handle stdio separately - add to local config only
  if (args.transport === "stdio") {
    await handleStdioAdd(ctx, msg, args);
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
        custom_headers:
          Object.keys(args.headers).length > 0 ? args.headers : null,
      };
    } else if (args.transport === "sse") {
      if (!args.url) {
        throw new Error("URL is required for SSE transport");
      }
      config = {
        mcp_server_type: "sse",
        server_url: args.url,
        auth_token: args.authToken,
        custom_headers:
          Object.keys(args.headers).length > 0 ? args.headers : null,
      };
    } else {
      // This path shouldn't be reached anymore - stdio is handled separately
      throw new Error("Invalid transport type");
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
      const errorMsg =
        refreshErr instanceof Error ? refreshErr.message : "Unknown error";
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

// Handle stdio-specific add (server-aware approach from design document)
async function handleStdioAdd(
  ctx: McpCommandContext,
  msg: string,
  args: McpAddArgs,
): Promise<void> {
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Adding stdio MCP server "${args.name}"...`,
    false,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    const { localMcpConfig } = await import("../../mcp/local-config");
    const { stdioClientManager } = await import("../../mcp/stdio-client");
    const { registerMcpToolsWithServer } = await import(
      "../../mcp/server-registration"
    );
    const { tryGetCurrentAgentId } = await import("../../agent/context");

    if (!args.command) {
      throw new Error("Command is required for stdio transport");
    }

    // Generate unique ID
    const serverId = `stdio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Step 1: Add to local config
    localMcpConfig.addStdioServer({
      id: serverId,
      name: args.name,
      command: args.command,
      args: args.args,
    });

    // Step 2: Spawn subprocess and connect
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Spawning stdio subprocess and connecting...\n` +
        `Command: ${args.command} ${args.args.join(" ")}`,
      false,
      "running",
    );

    await stdioClientManager.connect({
      serverId,
      serverName: args.name,
      command: args.command,
      args: args.args,
    });

    // Step 3: Fetch tool definitions
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Connected to stdio server.\nFetching tool definitions...`,
      false,
      "running",
    );

    const tools = await stdioClientManager.listTools(serverId);

    // Step 4: Register tools with Letta Cloud (server-aware approach)
    const agentId = tryGetCurrentAgentId();
    if (!agentId) {
      // No agent context yet - just store locally
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `✓ Added local stdio server "${args.name}"\n\n` +
          `Server Details:\n` +
          `  ID: ${serverId}\n` +
          `  Command: ${args.command} ${args.args.join(" ")}\n` +
          `  Tools: ${tools.length}\n` +
          `  Status: Running client-side (local only)\n\n` +
          `Note: No active agent. Tools stored locally.\n` +
          `They will be registered when you select an agent.`,
        true,
      );
      return;
    }

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Found ${tools.length} tools.\nRegistering with Letta Cloud as CLIENT_MCP tools...`,
      false,
      "running",
    );

    const { registered, errors } = await registerMcpToolsWithServer(
      agentId,
      serverId,
      args.name,
      tools,
    );

    // Build success/error message
    let resultMessage = `✓ Added stdio MCP server "${args.name}"\n\n`;
    resultMessage += `Server Details:\n`;
    resultMessage += `  ID: ${serverId}\n`;
    resultMessage += `  Command: ${args.command} ${args.args.join(" ")}\n`;
    resultMessage += `  Status: Running client-side\n\n`;
    resultMessage += `Tool Registration:\n`;
    resultMessage += `  Registered: ${registered.length}/${tools.length} tools\n`;

    if (registered.length > 0) {
      resultMessage += `  Tools: ${registered.slice(0, 5).join(", ")}`;
      if (registered.length > 5) {
        resultMessage += `, +${registered.length - 5} more`;
      }
      resultMessage += `\n`;
    }

    if (errors.length > 0) {
      resultMessage += `\n⚠ Registration Errors:\n`;
      for (const err of errors.slice(0, 3)) {
        resultMessage += `  - ${err.tool}: ${err.error}\n`;
      }
      if (errors.length > 3) {
        resultMessage += `  - ...and ${errors.length - 3} more\n`;
      }
    }

    resultMessage += `\nExecution Model:\n`;
    resultMessage += `  - Agent calls tool via Letta Cloud\n`;
    resultMessage += `  - Server sends approval request to client\n`;
    resultMessage += `  - Client executes via stdio subprocess\n`;
    resultMessage += `  - Client returns result to server\n\n`;
    resultMessage += `Use /mcp to view and manage servers.`;

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      resultMessage,
      errors.length === 0, // Success only if no errors
    );
  } catch (error) {
    // Cleanup on error
    try {
      const { localMcpConfig } = await import("../../mcp/local-config");
      localMcpConfig.removeStdioServer(args.name);
    } catch {
      // Ignore cleanup errors
    }

    const errorDetails =
      error instanceof Error ? error.message : String(error);
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Failed to add stdio server: ${errorDetails}\n\n` +
        `Make sure:\n` +
        `  1. The command is valid: ${args.command} ${args.args.join(" ")}\n` +
        `  2. You have an active agent selected\n` +
        `  3. The Letta server is accessible\n\n` +
        `Try running the command manually first to verify it works.`,
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
      "  /mcp                  - Open MCP server manager\n" +
      "  /mcp add ...          - Add a new server (without OAuth)\n" +
      "  /mcp connect          - Interactive wizard with OAuth support\n\n" +
      "Transport types:\n" +
      "  http/sse              - Remote servers (tools run server-side)\n" +
      "  stdio                 - Local subprocesses (tools run client-side)\n\n" +
      "Examples:\n" +
      "  /mcp add --transport http notion https://mcp.notion.com/mcp\n" +
      "  /mcp add --transport stdio filesystem npx @modelcontextprotocol/server-filesystem /path\n\n" +
      "Note: Stdio servers are managed locally and never sent to the Letta server.",
    false,
  );
}
