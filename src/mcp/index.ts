// src/mcp/index.ts
// MCP (Model Context Protocol) support for Letta Code

export { stdioClientManager } from "./stdio-client";
export { mcpToolTracker } from "./tracker";
export { executeStdioMcpTool, cleanupStdioConnections } from "./executor";
export { localMcpConfig } from "./local-config";
export {
  registerMcpToolsWithServer,
  unregisterMcpToolsFromServer,
  isMcpToolRegisteredWithServer,
  getMcpServerIdForTool,
} from "./server-registration";
