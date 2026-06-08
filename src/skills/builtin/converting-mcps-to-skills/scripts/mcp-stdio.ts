#!/usr/bin/env npx tsx
/**
 * MCP stdio Client - Connect to any MCP server over stdio
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

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: object;
  id: number;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: object;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  id: number;
}

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
  // Simple parsing - split on spaces, respecting quotes.
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

let serverProcess: ChildProcessWithoutNullStreams | null = null;
let stdoutBuffer = "";
let nextRequestId = 1;
const pendingRequests = new Map<
  number,
  {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }
>();

function handleStdout(chunk: Buffer): void {
  stdoutBuffer += chunk.toString("utf8");

  while (true) {
    const newlineIndex = stdoutBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }

    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

    if (!line) {
      continue;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`[server stdout] ${line}\n`);
      continue;
    }

    if (
      typeof message !== "object" ||
      message === null ||
      !("id" in message) ||
      typeof message.id !== "number"
    ) {
      continue;
    }

    const pending = pendingRequests.get(message.id);
    if (!pending) {
      continue;
    }

    pendingRequests.delete(message.id);
    pending.resolve(message as JsonRpcResponse);
  }
}

function rejectPendingRequests(error: Error): void {
  for (const pending of pendingRequests.values()) {
    pending.reject(error);
  }
  pendingRequests.clear();
}

async function connect(
  serverCommand: string,
  env: Record<string, string>,
  cwd?: string,
): Promise<void> {
  const { command, args } = parseCommand(serverCommand);

  if (!command) {
    throw new Error("No command specified");
  }

  // Merge with process.env.
  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }
  Object.assign(mergedEnv, env);

  serverProcess = spawn(command, args, {
    cwd,
    env: mergedEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", handleStdout);
  serverProcess.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[server] ${chunk.toString()}`);
  });
  serverProcess.on("error", (error) => {
    rejectPendingRequests(error);
  });
  serverProcess.on("exit", (code, signal) => {
    rejectPendingRequests(
      new Error(`MCP server exited with code ${code} signal ${signal}`),
    );
  });

  const initializeResponse = await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "mcp-stdio-cli",
      version: "1.0.0",
    },
  });

  if (initializeResponse.error) {
    throw new Error(
      `Initialization failed: ${initializeResponse.error.message}`,
    );
  }

  sendNotification("notifications/initialized", {});
}

function sendMessage(message: JsonRpcRequest | JsonRpcNotification): void {
  if (!serverProcess) {
    throw new Error("MCP server is not connected");
  }

  serverProcess.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendNotification(method: string, params?: object): void {
  sendMessage({ jsonrpc: "2.0", method, params });
}

function sendRequest(
  method: string,
  params?: object,
): Promise<JsonRpcResponse> {
  const id = nextRequestId++;
  const request: JsonRpcRequest = { jsonrpc: "2.0", method, params, id };

  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    sendMessage(request);
  });
}

async function cleanup(): Promise<void> {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  serverProcess = null;
}

async function listTools(): Promise<void> {
  const response = await sendRequest("tools/list");

  if (response.error) {
    console.error("Error:", response.error.message);
    process.exit(1);
  }

  const result = response.result as {
    tools: Array<{ name: string; description?: string; inputSchema: object }>;
  };

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

async function listResources(): Promise<void> {
  const response = await sendRequest("resources/list");

  if (response.error) {
    console.error("Error:", response.error.message);
    process.exit(1);
  }

  const result = response.result as {
    resources: Array<{ uri: string; name: string; description?: string }>;
  };

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

async function getToolSchema(toolName: string): Promise<void> {
  const response = await sendRequest("tools/list");

  if (response.error) {
    console.error("Error:", response.error.message);
    process.exit(1);
  }

  const result = response.result as {
    tools: Array<{ name: string; description?: string; inputSchema: object }>;
  };

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

async function callTool(toolName: string, argsJson: string): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    console.error(`Invalid JSON: ${argsJson}`);
    process.exit(1);
  }

  const response = await sendRequest("tools/call", {
    name: toolName,
    arguments: args,
  });

  if (response.error) {
    console.error("Error:", response.error.message);
    if (response.error.data) {
      console.error("Details:", JSON.stringify(response.error.data, null, 2));
    }
    process.exit(1);
  }

  console.log(JSON.stringify(response.result, null, 2));
}

function printUsage(): void {
  console.log(`MCP stdio Client - Connect to any MCP server over stdio

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

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  try {
    await connect(serverCommand, env, cwd);

    switch (action) {
      case "list-tools":
        await listTools();
        break;

      case "list-resources":
        await listResources();
        break;

      case "info": {
        const [toolName] = actionArgs;
        if (!toolName) {
          console.error("Error: Tool name required");
          console.error("Usage: info <tool>");
          process.exit(1);
        }
        await getToolSchema(toolName);
        break;
      }

      case "call": {
        const [toolName, argsJson] = actionArgs;
        if (!toolName) {
          console.error("Error: Tool name required");
          console.error("Usage: call <tool> '<json-args>'");
          process.exit(1);
        }
        await callTool(toolName, argsJson || "{}");
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
