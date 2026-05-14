// src/cli/commands/mcp.ts
// MCP server command handlers

import type {
  CreateSseMcpServer,
  CreateStdioMcpServer,
  CreateStreamableHTTPMcpServer,
} from "@letta-ai/letta-client/resources/mcp-servers/mcp-servers";
import { getClient } from "../../backend/api/client";
import type { Buffers, Line } from "../helpers/accumulator";
import { formatErrorDetails } from "../helpers/errorFormatter";
import { getMCPManager, MCPManager} from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/manager";
import * as fs from 'fs/promises';
import * as path from 'path';
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
  clientSide: boolean | false;
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
  let clientSide = false;
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
    } else if (part === '--client-side'){
      clientSide = true;
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
    clientSide,
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
    const client = await getClient();

    if (args.clientSide){
      if (args.transport !== 'stdio') {
            updateCommandResult(ctx.buffersRef,ctx.refreshDerived,cmdId,msg,'Client-side execution only supported with stdio transport',false);
            return;
      }
      updateCommandResult(
            ctx.buffersRef,
            ctx.refreshDerived,
            cmdId,
            msg,
            `Creating MCP server "${args.name}" (client-side)...`,
            false,
            'running',
      );
        // stdio
      if (!args.command) {
        throw new Error("Command is required for stdio transport");
      }
      const server = await client.mcpServers.create({
        server_name: args.name,
        config: {
          mcp_server_type: 'stdio',
          command: args.command,
          args: args.args,
          // `execution_mode` is a new server-side field not yet in the generated SDK types.
          execution_mode: 'client',
        } as any,
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
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" (ID: ${server.id} )\nSpawning MCP server 
    locally...`,
        false,
        'running',
      );
      const mcpManager = getMCPManager();
      const config: MCPServerConfig = {
        name: args.name,
        command: args.command!,
        args: args.args,
        executionMode: 'client',
      };
      await mcpManager.spawnServer(config);

      // 3. Fetch tools from local MCP server
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" (ID:)\nSpawning MCP server 
    locally...\nFetching tools from server...`,
        false,
        'running',
      );

      const tools = await mcpManager.listTools(args.name);

      // 4. Register tools locally in letta-code
      await mcpManager.registerTools(args.name, tools);

      // 5. Register each tool with Letta server as client_executable
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created MCP server "${args.name}" (ID: )\nSpawning MCP server 
        locally...\nFetching tools from server...\nRegistering ${tools.length} 
        tool${tools.length === 1 ? '' : 's'} with Letta server...`,
        false,
        'running',
      );

     for (const tool of tools) {
        // `name` and `source_type: 'client_executable'` are new server-side fields
        // not yet present in the generated SDK types.
        await client.tools.create({
          name: tool.name,
          description: tool.description,
          json_schema: tool.inputSchema,
          source_type: 'client_executable',
          source_code: '# Client-side MCP tool',
          tags: [`mcp_client:${args.name}`],
          default_requires_approval: true,
          } as any);
      }
      // 6. Save MCP config locally for persistence
      const existingConfigs = await loadMCPConfigs();
      existingConfigs.push(config);
      await mcpManager.saveConfig(existingConfigs);

      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `Created client-side MCP server "${args.name}" (ID: )\nLoaded 
    ${tools.length} tool${tools.length === 1 ? '' : 's'} from server\nTools registered 
    with Letta server as client-executable`,
        true,
      );         
      return;
    }
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
      "Examples:\n" +
      "  /mcp add --transport http notion https://mcp.notion.com/mcp",
    false,
  );
}
async function loadMCPConfigs(): Promise<MCPServerConfig[]> {
  try {
    const configPath = path.join(process.cwd(), '.letta', 'mcp-servers.json');
    const content = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}