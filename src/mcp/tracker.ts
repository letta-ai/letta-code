// src/mcp/tracker.ts
// Tracks which tools belong to stdio MCP servers for client-side execution

import type {
  SseMcpServer,
  StdioMcpServer,
  StreamableHTTPMcpServer,
} from "@letta-ai/letta-client/resources/mcp-servers/mcp-servers";
import { getClient } from "../agent/client";
import { localMcpConfig } from "./local-config";
import { stdioClientManager } from "./stdio-client";

type McpServer = StreamableHTTPMcpServer | SseMcpServer | StdioMcpServer;

interface ToolServerMapping {
  toolId: string;
  toolName: string;
  serverId: string;
  serverName: string;
  serverType: "streamable_http" | "sse" | "stdio" | "stdio_local";
}

/**
 * Manages the mapping between tools and their MCP servers.
 * Used to identify which tools need client-side execution (stdio servers).
 */
class McpToolTracker {
  private toolMappings = new Map<string, ToolServerMapping>();
  private stdioServers = new Map<
    string,
    { name: string; command: string; args: string[] }
  >();
  private lastSync: number | null = null;
  private syncPromise: Promise<void> | null = null;

  /**
   * Sync tool mappings from the Letta server.
   * This should be called after agent initialization or when MCP servers change.
   */
  async sync(agentId: string): Promise<void> {
    // If sync is in progress, wait for it
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this._performSync(agentId);
    try {
      await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  private async _performSync(agentId: string): Promise<void> {
    try {
      const client = await getClient();

      // Fetch all MCP servers
      const servers = await client.mcpServers.list();

      // Clear existing mappings
      this.toolMappings.clear();
      this.stdioServers.clear();

      // For each server, fetch its tools and build mappings
      for (const server of servers) {
        if (!server.id) continue;

        try {
          const tools = await client.mcpServers.tools.list(server.id);

          for (const tool of tools) {
            if (!tool.id || !tool.name) continue;

            this.toolMappings.set(tool.name, {
              toolId: tool.id,
              toolName: tool.name,
              serverId: server.id,
              serverName: server.server_name,
              serverType: server.mcp_server_type,
            });
          }

          // Track stdio servers for client-side execution
          if (server.mcp_server_type === "stdio" && "command" in server) {
            this.stdioServers.set(server.id, {
              name: server.server_name,
              command: server.command,
              args: server.args,
            });

            // Ensure stdio client is connected
            await stdioClientManager.connect({
              serverId: server.id,
              serverName: server.server_name,
              command: server.command,
              args: server.args,
            });
          }
        } catch (error) {
          console.error(
            `[mcp] Failed to sync tools for server ${server.server_name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Load server-registered MCP tools (design document approach)
      await this.syncServerRegisteredMcpTools(agentId);

      // Also load local-only stdio servers (fallback/privacy approach)
      await this.syncLocalStdioServers();

      this.lastSync = Date.now();
      console.error(
        `[mcp] Synced ${this.toolMappings.size} MCP tools (${this.stdioServers.size} stdio servers)`,
      );
    } catch (error) {
      console.error(
        `[mcp] Failed to sync MCP tools: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Sync server-registered MCP tools (design document approach).
   * These are tools registered with Letta Cloud that are marked as MCP tools.
   */
  private async syncServerRegisteredMcpTools(agentId: string): Promise<void> {
    try {
      // Skip if agent ID is invalid (e.g., "loading" placeholder)
      if (!agentId || agentId === "loading" || !agentId.startsWith("agent-")) {
        console.error(
          `[mcp] Skipping server-registered MCP sync: invalid agent ID (${agentId})`,
        );
        return;
      }

      const client = await getClient();

      // Fetch agent's tools
      const agentTools = await client.agents.tools.list(agentId);

      // Find tools with MCP metadata
      for (const tool of agentTools.items || []) {
        const schema = tool.json_schema as Record<string, unknown>;
        const isMcp = schema?.["x-is-mcp"] === true;
        const serverId = schema?.["x-mcp-server"] as string | undefined;
        const serverName =
          (schema?.["x-mcp-server-name"] as string | undefined) || "unknown";

        if (isMcp && serverId && tool.name) {
          // Check if this stdio server is in our local config
          const localServer = localMcpConfig.getStdioServer(serverId);

          if (localServer) {
            // Ensure subprocess is connected
            if (!stdioClientManager.isConnected(serverId)) {
              await stdioClientManager.connect({
                serverId: localServer.id,
                serverName: localServer.name,
                command: localServer.command,
                args: localServer.args,
                env: localServer.env,
              });
            }

            // Add to mappings
            this.toolMappings.set(tool.name, {
              toolId: tool.id || `mcp-${serverId}-${tool.name}`,
              toolName: tool.name,
              serverId: serverId,
              serverName: serverName,
              serverType: "stdio", // Server-registered stdio
            });

            this.stdioServers.set(serverId, {
              name: serverName,
              command: localServer.command,
              args: localServer.args,
            });
          } else {
            console.error(
              `[mcp] Found server-registered MCP tool "${tool.name}" but local config missing for server ${serverId}`,
            );
          }
        }
      }

      const mcpToolCount = Array.from(this.toolMappings.values()).filter(
        (m) => m.serverType === "stdio",
      ).length;

      if (mcpToolCount > 0) {
        console.error(
          `[mcp] Synced ${mcpToolCount} server-registered MCP tools`,
        );
      }
    } catch (error) {
      console.error(
        `[mcp] Failed to sync server-registered MCP tools: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Sync local-only stdio servers (not registered with Letta backend).
   * These are managed entirely client-side (privacy-focused approach).
   */
  private async syncLocalStdioServers(): Promise<void> {
    const localServers = localMcpConfig.getStdioServers();

    for (const server of localServers) {
      // Skip servers that are already synced from server-registered MCP tools
      if (this.stdioServers.has(server.id)) {
        continue;
      }

      try {
        // Connect to the stdio server
        await stdioClientManager.connect({
          serverId: server.id,
          serverName: server.name,
          command: server.command,
          args: server.args,
          env: server.env,
        });

        // List tools from the server
        const tools = await stdioClientManager.listTools(server.id);

        // Add mappings for each tool
        for (const tool of tools) {
          // Only add if not already mapped (server-registered takes precedence)
          if (!this.toolMappings.has(tool.name)) {
            this.toolMappings.set(tool.name, {
              toolId: `local-${server.id}-${tool.name}`,
              toolName: tool.name,
              serverId: server.id,
              serverName: server.name,
              serverType: "stdio_local", // Mark as local-only
            });
          }
        }

        console.error(
          `[mcp] Loaded ${tools.length} tools from local stdio server: ${server.name}`,
        );
      } catch (error) {
        console.error(
          `[mcp] Failed to sync local stdio server ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Check if a tool belongs to a stdio MCP server (requires client-side execution).
   * @param toolName Tool name
   * @returns true if the tool is from a stdio server (local or remote)
   */
  isStdioTool(toolName: string): boolean {
    const mapping = this.toolMappings.get(toolName);
    return (
      mapping?.serverType === "stdio" || mapping?.serverType === "stdio_local"
    );
  }

  /**
   * Get the server ID for a tool.
   * @param toolName Tool name
   * @returns Server ID or null if not found
   */
  getToolServerId(toolName: string): string | null {
    return this.toolMappings.get(toolName)?.serverId ?? null;
  }

  /**
   * Get all stdio server IDs.
   */
  getStdioServerIds(): string[] {
    return Array.from(this.stdioServers.keys());
  }

  /**
   * Get stdio server config by ID.
   */
  getStdioServer(
    serverId: string,
  ): { name: string; command: string; args: string[] } | null {
    return this.stdioServers.get(serverId) ?? null;
  }

  /**
   * Check if sync is needed (no sync yet or stale).
   */
  needsSync(): boolean {
    if (!this.lastSync) return true;
    // Consider stale after 5 minutes
    return Date.now() - this.lastSync > 5 * 60 * 1000;
  }

  /**
   * Force a resync (useful after adding/removing MCP servers).
   */
  invalidate(): void {
    this.lastSync = null;
  }
}

// Singleton instance
export const mcpToolTracker = new McpToolTracker();
