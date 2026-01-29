// src/mcp/example.ts
// Example usage of stdio MCP client-side execution
// This file demonstrates how to use the MCP stdio support programmatically

import { cleanupStdioConnections, executeStdioMcpTool } from "./executor";
import { stdioClientManager } from "./stdio-client";
import { mcpToolTracker } from "./tracker";

/**
 * Example 1: Direct stdio client usage
 * Use this when you want full control over the MCP connection
 */
async function example1_DirectClient() {
  // Connect to a stdio MCP server
  await stdioClientManager.connect({
    serverId: "filesystem-local",
    serverName: "Filesystem",
    command: "npx",
    args: [
      "@modelcontextprotocol/server-filesystem",
      "/Users/yourusername/Documents",
    ],
  });

  // List available tools
  const tools = await stdioClientManager.listTools("filesystem-local");
  console.log("Available tools:", tools.map((t) => t.name));

  // Execute a tool
  const result = await stdioClientManager.executeTool(
    "filesystem-local",
    "read_file",
    { path: "example.txt" },
  );
  console.log("Result:", result);

  // Cleanup
  await stdioClientManager.disconnect("filesystem-local");
}

/**
 * Example 2: Using the tracker (recommended)
 * Use this when you want to work with tools registered in Letta
 */
async function example2_WithTracker() {
  const agentId = "agent-123"; // Your agent ID

  // Sync tools from Letta backend
  // This automatically connects to all stdio servers
  await mcpToolTracker.sync(agentId);

  // Check if a tool is from a stdio server
  const isStdio = mcpToolTracker.isStdioTool("read_file");
  console.log("Is stdio tool:", isStdio);

  // Get server ID for a tool
  const serverId = mcpToolTracker.getToolServerId("read_file");
  console.log("Server ID:", serverId);

  // Execute the tool (automatically routes to correct server)
  if (serverId) {
    const result = await stdioClientManager.executeTool(serverId, "read_file", {
      path: "example.txt",
    });
    console.log("Result:", result);
  }

  // Cleanup all connections
  await cleanupStdioConnections();
}

/**
 * Example 3: Using the executor (highest level)
 * Use this for seamless integration with existing tool execution
 */
async function example3_WithExecutor() {
  const agentId = "agent-123"; // Your agent ID

  // Sync tools
  await mcpToolTracker.sync(agentId);

  // Execute a tool - automatically detects if it's stdio and routes appropriately
  const result = await executeStdioMcpTool("read_file", {
    path: "example.txt",
  });

  if (result !== null) {
    // Tool was executed client-side
    console.log("Stdio result:", result);
  } else {
    // Tool is not a stdio tool (would be executed server-side)
    console.log("Not a stdio tool");
  }

  // Cleanup
  await cleanupStdioConnections();
}

/**
 * Example 4: Error handling
 */
async function example4_ErrorHandling() {
  try {
    await stdioClientManager.connect({
      serverId: "test-server",
      serverName: "Test",
      command: "invalid-command", // This will fail
      args: [],
    });
  } catch (error) {
    console.error("Connection failed:", error);
    // Error is logged to stderr and thrown
  }

  try {
    const result = await stdioClientManager.executeTool(
      "nonexistent-server",
      "some_tool",
      {},
    );
  } catch (error) {
    console.error("Tool execution failed:", error);
    // Error message: "Stdio MCP server not connected: nonexistent-server"
  }
}

/**
 * Example 5: Multiple servers
 */
async function example5_MultipleServers() {
  // Connect to multiple stdio servers
  await stdioClientManager.connect({
    serverId: "filesystem",
    serverName: "Filesystem",
    command: "npx",
    args: ["@modelcontextprotocol/server-filesystem", "/data"],
  });

  await stdioClientManager.connect({
    serverId: "postgres",
    serverName: "PostgreSQL",
    command: "npx",
    args: [
      "@modelcontextprotocol/server-postgres",
      "postgresql://localhost/mydb",
    ],
  });

  // Get all connected servers
  const servers = stdioClientManager.getConnectedServers();
  console.log("Connected servers:", servers);

  // Execute tools on different servers
  const fileResult = await stdioClientManager.executeTool(
    "filesystem",
    "read_file",
    { path: "data.txt" },
  );

  const dbResult = await stdioClientManager.executeTool(
    "postgres",
    "query",
    { sql: "SELECT * FROM users LIMIT 10" },
  );

  console.log("File result:", fileResult);
  console.log("DB result:", dbResult);

  // Cleanup all
  await cleanupStdioConnections();
}

// Run examples (comment out the ones you don't want to run)
if (import.meta.main) {
  // example1_DirectClient();
  // example2_WithTracker();
  // example3_WithExecutor();
  // example4_ErrorHandling();
  // example5_MultipleServers();
}

export {
  example1_DirectClient,
  example2_WithTracker,
  example3_WithExecutor,
  example4_ErrorHandling,
  example5_MultipleServers,
};
