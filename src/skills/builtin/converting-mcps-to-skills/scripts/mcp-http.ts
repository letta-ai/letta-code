#!/usr/bin/env npx tsx
/**
 * MCP HTTP Client - Connect to any MCP server over HTTP
 *
 * Usage:
 *   npx tsx mcp-http.ts <url> <command> [args]
 *
 * Commands:
 *   list-tools              List available tools
 *   list-resources          List available resources
 *   call <tool> '<json>'    Call a tool with JSON arguments
 *
 * Options:
 *   --header "Key: Value"   Add HTTP header (can be repeated)
 *
 * Examples:
 *   npx tsx mcp-http.ts http://localhost:3001/mcp list-tools
 *   npx tsx mcp-http.ts http://localhost:3001/mcp call vault '{"action":"list"}'
 *   npx tsx mcp-http.ts http://localhost:3001/mcp --header "Authorization: Bearer KEY" list-tools
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: object;
  id: number;
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
  url: string;
  command: string;
  commandArgs: string[];
  headers: Record<string, string>;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const headers: Record<string, string> = {};
  let url = "";
  let command = "";
  const commandArgs: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) {
      i++;
      continue;
    }

    if (arg === "--header" || arg === "-H") {
      const headerValue = args[++i];
      if (headerValue) {
        const colonIndex = headerValue.indexOf(":");
        if (colonIndex > 0) {
          const key = headerValue.slice(0, colonIndex).trim();
          const value = headerValue.slice(colonIndex + 1).trim();
          headers[key] = value;
        }
      }
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!url && arg.startsWith("http")) {
      url = arg;
    } else if (!command) {
      command = arg;
    } else {
      commandArgs.push(arg);
    }
    i++;
  }

  return { url, command, commandArgs, headers };
}

// Session state
let sessionId: string | null = null;
let initialized = false;
let requestHeaders: Record<string, string> = {};
let serverUrl = "";

async function rawMcpRequest(
  method: string,
  params?: object,
): Promise<{ response: JsonRpcResponse; newSessionId?: string }> {
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
    params,
    id: Date.now(),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...requestHeaders,
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  try {
    const fetchResponse = await fetch(serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });

    // Capture session ID from response
    const newSessionId =
      fetchResponse.headers.get("Mcp-Session-Id") || undefined;

    if (!fetchResponse.ok) {
      const text = await fetchResponse.text();
      if (fetchResponse.status === 401) {
        throw new Error(
          `Authentication required.\n` +
            `Add --header "Authorization: Bearer YOUR_KEY" or similar.`,
        );
      }

      // Try to parse as JSON-RPC error
      try {
        const errorResponse = JSON.parse(text) as JsonRpcResponse;
        return { response: errorResponse, newSessionId };
      } catch {
        throw new Error(
          `HTTP ${fetchResponse.status}: ${fetchResponse.statusText}\n${text}`,
        );
      }
    }

    const contentType = fetchResponse.headers.get("content-type") || "";

    // Handle JSON response
    if (contentType.includes("application/json")) {
      const jsonResponse = (await fetchResponse.json()) as JsonRpcResponse;
      return { response: jsonResponse, newSessionId };
    }

    // Handle SSE stream (simplified - just collect all events)
    if (contentType.includes("text/event-stream")) {
      const text = await fetchResponse.text();
      const dataLines = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));

      for (let i = dataLines.length - 1; i >= 0; i--) {
        const line = dataLines[i];
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.jsonrpc === "2.0") {
            return { response: parsed as JsonRpcResponse, newSessionId };
          }
        } catch {
          // Continue to previous line
        }
      }
      throw new Error("No valid JSON-RPC response found in SSE stream");
    }

    throw new Error(`Unexpected content type: ${contentType}`);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error(
        `Cannot connect to ${serverUrl}\nIs the MCP server running?`,
      );
    }
    throw error;
  }
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;

  const { response, newSessionId } = await rawMcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "mcp-http-cli",
      version: "1.0.0",
    },
  });

  if (newSessionId) {
    sessionId = newSessionId;
  }

  if (response.error) {
    throw new Error(`Initialization failed: ${response.error.message}`);
  }

  // Send initialized notification
  await rawMcpRequest("notifications/initialized", {});

  initialized = true;
}

async function mcpRequest(
  method: string,
  params?: object,
): Promise<JsonRpcResponse> {
  await ensureInitialized();

  const { response, newSessionId } = await rawMcpRequest(method, params);

  if (newSessionId) {
    sessionId = newSessionId;
  }

  return response;
}

async function listTools(): Promise<void> {
  const response = await mcpRequest("tools/list");

  if (response.error) {
    console.error("Error:", response.error.message);
    process.exit(1);
  }

  const result = response.result as {
    tools: Array<{ name: string; description: string; inputSchema: object }>;
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
  const response = await mcpRequest("resources/list");

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

async function callTool(toolName: string, argsJson: string): Promise<void> {
  let args: object;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    console.error(`Invalid JSON: ${argsJson}`);
    process.exit(1);
  }

  const response = await mcpRequest("tools/call", {
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

async function getToolSchema(toolName: string): Promise<void> {
  const response = await mcpRequest("tools/list");

  if (response.error) {
    console.error("Error:", response.error.message);
    process.exit(1);
  }

  const result = response.result as {
    tools: Array<{ name: string; description: string; inputSchema: object }>;
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

function printUsage(): void {
  console.log(`MCP HTTP Client - Connect to any MCP server over HTTP

Usage: npx tsx mcp-http.ts <url> [options] <command> [args]

Commands:
  list-tools              List available tools with descriptions
  list-resources          List available resources
  info <tool>             Show tool schema/parameters
  call <tool> '<json>'    Call a tool with JSON arguments

Options:
  --header, -H "K: V"     Add HTTP header (repeatable)
  --help, -h              Show this help

Examples:
  # List tools from a server
  npx tsx mcp-http.ts http://localhost:3001/mcp list-tools

  # With authentication
  npx tsx mcp-http.ts http://localhost:3001/mcp --header "Authorization: Bearer KEY" list-tools

  # Get tool schema
  npx tsx mcp-http.ts http://localhost:3001/mcp info vault

  # Call a tool
  npx tsx mcp-http.ts http://localhost:3001/mcp call vault '{"action":"list"}'
`);
}

async function main(): Promise<void> {
  const { url, command, commandArgs, headers } = parseArgs();

  if (!url) {
    console.error("Error: URL is required\n");
    printUsage();
    process.exit(1);
  }

  if (!command) {
    console.error("Error: Command is required\n");
    printUsage();
    process.exit(1);
  }

  // Set globals
  serverUrl = url;
  requestHeaders = headers;

  try {
    switch (command) {
      case "list-tools":
        await listTools();
        break;

      case "list-resources":
        await listResources();
        break;

      case "info": {
        const [toolName] = commandArgs;
        if (!toolName) {
          console.error("Error: Tool name required");
          console.error("Usage: info <tool>");
          process.exit(1);
        }
        await getToolSchema(toolName);
        break;
      }

      case "call": {
        const [toolName, argsJson] = commandArgs;
        if (!toolName) {
          console.error("Error: Tool name required");
          console.error("Usage: call <tool> '<json-args>'");
          process.exit(1);
        }
        await callTool(toolName, argsJson || "{}");
        break;
      }

      default:
        console.error(`Unknown command: ${command}\n`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
