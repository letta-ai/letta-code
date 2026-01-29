// src/mcp/stdio-client.ts
// Client-side stdio MCP server manager

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface StdioServerConfig {
  serverId: string;
  serverName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Manages client-side stdio MCP connections.
 * Each stdio server runs as a subprocess and communicates via stdin/stdout.
 */
class StdioClientManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, StdioClientTransport>();
  private configs = new Map<string, StdioServerConfig>();
  private initializationPromises = new Map<string, Promise<void>>();

  /**
   * Register and connect to a stdio MCP server.
   * @param config Server configuration
   */
  async connect(config: StdioServerConfig): Promise<void> {
    // If already connected, skip
    if (this.clients.has(config.serverId)) {
      return;
    }

    // If initialization in progress, wait for it
    const existingInit = this.initializationPromises.get(config.serverId);
    if (existingInit) {
      return existingInit;
    }

    // Start new initialization
    const initPromise = this._initializeConnection(config);
    this.initializationPromises.set(config.serverId, initPromise);

    try {
      await initPromise;
    } finally {
      this.initializationPromises.delete(config.serverId);
    }
  }

  private async _initializeConnection(
    config: StdioServerConfig,
  ): Promise<void> {
    try {
      // Create transport (which will spawn the process internally)
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });

      // Create client
      const client = new Client(
        {
          name: "letta-code",
          version: "1.0.0",
        },
        {
          capabilities: {},
        },
      );

      // Connect
      await client.connect(transport);

      // Store
      this.clients.set(config.serverId, client);
      this.transports.set(config.serverId, transport);
      this.configs.set(config.serverId, config);

      console.error(
        `[mcp] Connected to stdio server: ${config.serverName} (${config.serverId})`,
      );
    } catch (error) {
      console.error(
        `[mcp] Failed to connect to ${config.serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Execute a tool on a stdio MCP server.
   * @param serverId Server ID
   * @param toolName Tool name
   * @param args Tool arguments
   * @returns Tool execution result
   */
  async executeTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(
        `[mcp] Stdio MCP server not connected: ${serverId}. Call connect() first.`,
      );
    }

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return result;
    } catch (error) {
      console.error(
        `[mcp] Tool execution failed for ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * List tools available from a stdio server.
   * @param serverId Server ID
   * @returns Array of tool information
   */
  async listTools(serverId: string): Promise<
    Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>
  > {
    const client = this.clients.get(serverId);
    if (!client) {
      throw new Error(
        `[mcp] Stdio MCP server not connected: ${serverId}. Call connect() first.`,
      );
    }

    try {
      const response = await client.listTools();
      return response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    } catch (error) {
      console.error(
        `[mcp] Failed to list tools: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Disconnect from a stdio server.
   * @param serverId Server ID
   */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    const transport = this.transports.get(serverId);

    if (client) {
      try {
        await client.close();
      } catch (error) {
        console.error(
          `[mcp] Error closing client: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        console.error(
          `[mcp] Error closing transport: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.clients.delete(serverId);
    this.transports.delete(serverId);
    this.configs.delete(serverId);

    console.error(`[mcp] Disconnected from stdio server: ${serverId}`);
  }

  /**
   * Disconnect from all stdio servers.
   */
  async disconnectAll(): Promise<void> {
    const serverIds = Array.from(this.clients.keys());
    await Promise.all(serverIds.map((id) => this.disconnect(id)));
  }

  /**
   * Check if a server is connected.
   * @param serverId Server ID
   */
  isConnected(serverId: string): boolean {
    return this.clients.has(serverId);
  }

  /**
   * Get all connected server IDs.
   */
  getConnectedServers(): string[] {
    return Array.from(this.clients.keys());
  }
}

// Singleton instance
export const stdioClientManager = new StdioClientManager();
