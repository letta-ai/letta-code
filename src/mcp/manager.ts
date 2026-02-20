import * as fs from 'fs/promises';
import * as path from 'path';
import { MCPStdioClient, type MCPTool } from './stdio-client';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  executionMode?: 'server' | 'client';
}

export interface MCPToolInfo {
  serverName: string;
  tool: MCPTool;
}

export class MCPManager {
  private servers = new Map<string, MCPStdioClient>();
  private toolRegistry = new Map<string, MCPToolInfo>();
  private configPath: string;

  constructor() {
    this.configPath = path.join(process.cwd(), '.letta', 'mcp-servers.json');
  }

  async loadFromConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const configs: MCPServerConfig[] = JSON.parse(content);
      
      console.log(`[MCP Manager] Loading ${configs.length} servers from config`);
      
      for (const config of configs) {
        // Only load client-side servers
        if (config.executionMode === 'client') {
          await this.spawnServer(config);
        }
      }
    } catch (error) {
      // No config file yet, that's okay
      console.log('[MCP Manager] No existing config file');
    }
  }

  async spawnServer(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      console.log(`[MCP Manager] Server "${config.name}" already running`);
      return;
    }

    console.log(`[MCP Manager] Spawning server: ${config.name}`);
    const client = new MCPStdioClient(config.command, config.args);
    
    await client.connect();
    this.servers.set(config.name, client);
    
    console.log(`[MCP Manager] Server "${config.name}" connected`);
  }

  async registerTools(
    serverName: string,
    tools: MCPTool[],
  ): Promise<void> {
    for (const tool of tools) {
      this.toolRegistry.set(tool.name, {
        serverName,
        tool,
      });
    }
    console.log(
      `[MCP Manager] Registered ${tools.length} tools from "${serverName}"`,
    );
  }

  async registerAllToolsWithClient(): Promise<void> {
    console.log('[MCP Manager] Registering tools from all MCP servers...');

    for (const [serverName, clientInstance] of this.servers) {
      if (!clientInstance.isConnected()) {
        console.log(`[MCP Manager] Skipping disconnected server: ${serverName}`);
        continue;
      }

      try {
        // Fetch tools from MCP server
        const tools = await clientInstance.listTools();

        // Register tools locally in letta-code's tool registry
        // Note: Tools are already registered with Letta server from 'mcp add' command
        await this.registerTools(serverName, tools);
      } catch (error) {
        console.error(`[MCP Manager] Failed to list tools from ${serverName}:`, error);
      }
    }

    console.log('[MCP Manager] Completed registering tools locally');
  }

  async executeTool(
    serverName: string,
    toolName: string,
    args: Record<string, any>,
  ): Promise<string> {
    const client = this.servers.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" not found`);
    }

    if (!client.isConnected()) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    const result = await client.callTool(toolName, args);
    
    if (result.isError) {
      throw new Error(
        `MCP tool error: ${JSON.stringify(result.content)}`,
      );
    }

    // Extract text content from result
    const textParts = result.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
    
    return textParts || 'Empty response';
  }

  async listTools(serverName: string): Promise<MCPTool[]> {
    const client = this.servers.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" not found`);
    }

    return await client.listTools();
  }

  getToolInfo(toolName: string): MCPToolInfo | undefined {
    return this.toolRegistry.get(toolName);
  }

  async saveConfig(servers: MCPServerConfig[]): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(
      this.configPath,
      JSON.stringify(servers, null, 2),
    );
    console.log(`[MCP Manager] Saved config with ${servers.length} servers`);
  }

  async shutdown(): Promise<void> {
    console.log('[MCP Manager] Shutting down all servers...');
    for (const [name, client] of this.servers) {
      console.log(`[MCP Manager] Shutting down: ${name}`);
      client.disconnect();
    }
    this.servers.clear();
    this.toolRegistry.clear();
  }

  getServerNames(): string[] {
    return Array.from(this.servers.keys());
  }
}

// Global instance
let globalMCPManager: MCPManager | null = null;

export function getMCPManager(): MCPManager {
  if (!globalMCPManager) {
    globalMCPManager = new MCPManager();
  }
  return globalMCPManager;
}

export function setGlobalMCPManager(manager: MCPManager): void {
  globalMCPManager = manager;
}