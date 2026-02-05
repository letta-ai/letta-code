#!/usr/bin/env npx tsx
/**
 * MCP stdio Client - Connect to any MCP server over stdio
 *
 * NOTE: Requires npm install in this directory first:
 *   cd <this-directory> && npm install
 *
 * Usage:
 *   npx tsx mcp-stdio.ts "<command>" <action> [args]
 *
 * Commands:
 *   list-tools              List available tools
 *   list-resources          List available resources
 *   info <tool>             Show tool schema
 *   call <tool> '<json>'    Call a tool with JSON arguments
 *
 * Options:
 *   --env "KEY=VALUE"       Set environment variable (can be repeated)
 *   --cwd <path>            Set working directory for server
 *
 * Examples:
 *   npx tsx mcp-stdio.ts "node server.js" list-tools
 *   npx tsx mcp-stdio.ts "npx -y @modelcontextprotocol/server-filesystem ." list-tools
 *   npx tsx mcp-stdio.ts "python server.py" call my_tool '{"arg":"value"}'
 *   npx tsx mcp-stdio.ts "node server.js" --env "API_KEY=xxx" list-tools
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface ParsedArgs {
  serverCommand: string;
  action: string;
  actionArgs: string[];
  env: Record<string, string>;
  cwd?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const env: Record<string, string> = {};
  let cwd: string | undefined;
  let serverCommand = "";
  let action = "";
  const actionArgs: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) {
      i++;
      continue;
    }

    if (arg === "--env" || arg === "-e") {
      const envValue = args[++i];
      if (envValue) {
        const eqIndex = envValue.indexOf("=");
        if (eqIndex > 0) {
          const key = envValue.slice(0, eqIndex);
          const value = envValue.slice(eqIndex + 1);
          env[key] = value;
        }
      }
    } else if (arg === "--cwd") {
      cwd = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!serverCommand) {
      serverCommand = arg;
    } else if (!action) {
      action = arg;
    } else {
      actionArgs.push(arg);
    }
    i++;
  }

  return { serverCommand, action, actionArgs, env, cwd };
}

function parseCommand(commandStr: string): { command: string; args: string[] } {
  // Simple parsing - split on spaces, respecting quotes
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const char of commandStr) {
    if ((char === '"' || char === "'") && !inQuote) {
      inQuote = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuote) {
      inQuote = false;
      quoteChar = "";
    } else if (char === " " && !inQuote) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    parts.push(current);
  }

  return {
    command: parts[0] || "",
    args: parts.slice(1),
  };
}

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

async function connect(
  serverCommand: string,
  env: Record<string, string>,
  cwd?: string,
): Promise<Client> {
  const { command, args } = parseCommand(serverCommand);

  if (!command) {
    throw new Error("No command specified");
  }

  // Merge with process.env
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }
  Object.assign(mergedEnv, env);

  transport = new StdioClientTransport({
    command,
    args,
    env: mergedEnv,
    cwd,
    stderr: "pipe",
  });

  // Forward stderr for debugging
  if (transport.stderr) {
    transport.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[server] ${chunk.toString()}`);
    });
  }

  client = new Client(
    {
      name: "mcp-stdio-cli",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await client.connect(transport);
  return client;
}

async function cleanup(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function listTools(client: Client): Promise<void> {
  const result = await client.listTools();

  console.log("Available tools:\n");
  for (const tool of result.tools) {
    console.log(`  ${tool.name}`);
    if (tool.description) {
      console.log(`    ${tool.description}\n`);
    } else {
      console.log();
    }
  }

  console.log(`\nTotal: ${result.tools.length} tools`);
  console.log("\nUse 'call <tool> <json-args>' to invoke a tool");
}

async function listResources(client: Client): Promise<void> {
  const result = await client.listResources();

  if (!result.resources || result.resources.length === 0) {
    console.log("No resources available.");
    return;
  }

  console.log("Available resources:\n");
  for (const resource of result.resources) {
    console.log(`  ${resource.uri}`);
    console.log(`    ${resource.name}`);
    if (resource.description) {
      console.log(`    ${resource.description}`);
    }
    console.log();
  }
}

async function getToolSchema(client: Client, toolName: string): Promise<void> {
  const result = await client.listTools();

  const tool = result.tools.find((t) => t.name === toolName);
  if (!tool) {
    console.error(`Tool not found: ${toolName}`);
    console.error(
      `Available tools: ${result.tools.map((t) => t.name).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`Tool: ${tool.name}\n`);
  if (tool.description) {
    console.log(`Description: ${tool.description}\n`);
  }
  console.log("Input Schema:");
  console.log(JSON.stringify(tool.inputSchema, null, 2));
}

async function callTool(
  client: Client,
  toolName: string,
  argsJson: string,
): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    console.error(`Invalid JSON: ${argsJson}`);
    process.exit(1);
  }

  const result = await client.callTool({
    name: toolName,
    arguments: args,
  });

  console.log(JSON.stringify(result, null, 2));
}

function printUsage(): void {
  console.log(`MCP stdio Client - Connect to any MCP server over stdio

NOTE: Requires npm install in this directory first:
  cd <this-directory> && npm install

Usage: npx tsx mcp-stdio.ts "<command>" [options] <action> [args]

Actions:
  list-tools              List available tools with descriptions
  list-resources          List available resources
  info <tool>             Show tool schema/parameters
  call <tool> '<json>'    Call a tool with JSON arguments

Options:
  --env, -e "KEY=VALUE"   Set environment variable (repeatable)
  --cwd <path>            Set working directory for server
  --help, -h              Show this help

Examples:
  # List tools from filesystem server
  npx tsx mcp-stdio.ts "npx -y @modelcontextprotocol/server-filesystem ." list-tools

  # With environment variable
  npx tsx mcp-stdio.ts "node server.js" --env "API_KEY=xxx" list-tools

  # Call a tool
  npx tsx mcp-stdio.ts "python server.py" call read_file '{"path":"./README.md"}'
`);
}

async function main(): Promise<void> {
  const { serverCommand, action, actionArgs, env, cwd } = parseArgs();

  if (!serverCommand) {
    console.error("Error: Server command is required\n");
    printUsage();
    process.exit(1);
  }

  if (!action) {
    console.error("Error: Action is required\n");
    printUsage();
    process.exit(1);
  }

  // Handle process exit
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  try {
    const connectedClient = await connect(serverCommand, env, cwd);

    switch (action) {
      case "list-tools":
        await listTools(connectedClient);
        break;

      case "list-resources":
        await listResources(connectedClient);
        break;

      case "info": {
        const [toolName] = actionArgs;
        if (!toolName) {
          console.error("Error: Tool name required");
          console.error("Usage: info <tool>");
          process.exit(1);
        }
        await getToolSchema(connectedClient, toolName);
        break;
      }

      case "call": {
        const [toolName, argsJson] = actionArgs;
        if (!toolName) {
          console.error("Error: Tool name required");
          console.error("Usage: call <tool> '<json-args>'");
          process.exit(1);
        }
        await callTool(connectedClient, toolName, argsJson || "{}");
        break;
      }

      default:
        console.error(`Unknown action: ${action}\n`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await cleanup();
  }
}

main();
