// src/mcp/executor.ts
// Client-side execution of stdio MCP tools

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutionResult } from "../tools/manager";
import { stdioClientManager } from "./stdio-client";
import { mcpToolTracker } from "./tracker";

/**
 * Convert MCP CallToolResult to Letta ToolExecutionResult format.
 */
function convertMcpResult(mcpResult: CallToolResult): ToolExecutionResult {
  // Extract text content from MCP result
  let textContent = "";
  const contentArray = Array.isArray(mcpResult.content)
    ? mcpResult.content
    : [mcpResult.content];

  for (const item of contentArray) {
    if (item.type === "text") {
      textContent += item.text;
    } else if (item.type === "image") {
      // For images, include a reference
      textContent += `[Image: ${item.data.substring(0, 50)}...]`;
    } else if (item.type === "resource") {
      // For resources, include the URI
      textContent += `[Resource: ${item.resource.uri}]`;
    }
  }

  return {
    toolReturn: textContent || "(empty response)",
    status: mcpResult.isError ? "error" : "success",
    stdout: undefined,
    stderr: mcpResult.isError ? textContent : undefined,
  };
}

/**
 * Execute a tool client-side if it belongs to a stdio MCP server.
 * Returns null if the tool is not a stdio MCP tool (caller should execute server-side).
 *
 * @param toolName Tool name
 * @param args Tool arguments
 * @returns ToolExecutionResult if stdio tool, null otherwise
 */
export async function executeStdioMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  // Check if this is a stdio MCP tool
  if (!mcpToolTracker.isStdioTool(toolName)) {
    return null;
  }

  const serverId = mcpToolTracker.getToolServerId(toolName);
  if (!serverId) {
    throw new Error(`[mcp] Could not find server for stdio tool: ${toolName}`);
  }

  // Ensure client is connected
  if (!stdioClientManager.isConnected(serverId)) {
    const serverConfig = mcpToolTracker.getStdioServer(serverId);
    if (!serverConfig) {
      throw new Error(`[mcp] Could not find config for server: ${serverId}`);
    }

    await stdioClientManager.connect({
      serverId,
      serverName: serverConfig.name,
      command: serverConfig.command,
      args: serverConfig.args,
    });
  }

  // Execute the tool
  try {
    console.error(
      `[mcp] Executing stdio tool client-side: ${toolName} (server: ${serverId})`,
    );
    const mcpResult = await stdioClientManager.executeTool(
      serverId,
      toolName,
      args,
    );
    return convertMcpResult(mcpResult);
  } catch (error) {
    const errorMessage = `[mcp] Stdio tool execution failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(errorMessage);
    return {
      toolReturn: errorMessage,
      status: "error",
      stderr: errorMessage,
    };
  }
}

/**
 * Cleanup all stdio MCP connections.
 * Call this on graceful shutdown.
 */
export async function cleanupStdioConnections(): Promise<void> {
  await stdioClientManager.disconnectAll();
}
