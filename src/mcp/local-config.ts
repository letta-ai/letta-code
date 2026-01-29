// src/mcp/local-config.ts
// Local-only stdio MCP server configuration (not synced to Letta server)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface StdioServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface LocalMcpConfig {
  stdioServers: StdioServerConfig[];
}

const CONFIG_DIR = join(homedir(), ".letta");
const MCP_CONFIG_FILE = join(CONFIG_DIR, "mcp-stdio.json");

/**
 * Manages local-only stdio MCP server configurations.
 * These are stored client-side and never sent to the Letta server.
 */
class LocalMcpConfigManager {
  private config: LocalMcpConfig | null = null;

  /**
   * Load local config from disk.
   */
  private loadConfig(): LocalMcpConfig {
    if (this.config) return this.config;

    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Load or create config file
    if (existsSync(MCP_CONFIG_FILE)) {
      try {
        const content = readFileSync(MCP_CONFIG_FILE, "utf-8");
        this.config = JSON.parse(content);
      } catch (error) {
        console.error(
          `[mcp] Failed to load config: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.config = { stdioServers: [] };
      }
    } else {
      this.config = { stdioServers: [] };
      this.saveConfig();
    }

    return this.config;
  }

  /**
   * Save config to disk.
   */
  private saveConfig(): void {
    if (!this.config) return;

    try {
      writeFileSync(MCP_CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error(
        `[mcp] Failed to save config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Add a stdio server to local config.
   */
  addStdioServer(config: StdioServerConfig): void {
    const currentConfig = this.loadConfig();

    // Check if server already exists
    const existing = currentConfig.stdioServers.find(
      (s) => s.id === config.id || s.name === config.name,
    );
    if (existing) {
      throw new Error(
        `Stdio server with name "${config.name}" already exists`,
      );
    }

    currentConfig.stdioServers.push(config);
    this.saveConfig();

    console.error(`[mcp] Added local stdio server: ${config.name}`);
  }

  /**
   * Remove a stdio server from local config.
   */
  removeStdioServer(idOrName: string): boolean {
    const currentConfig = this.loadConfig();
    const initialLength = currentConfig.stdioServers.length;

    currentConfig.stdioServers = currentConfig.stdioServers.filter(
      (s) => s.id !== idOrName && s.name !== idOrName,
    );

    if (currentConfig.stdioServers.length < initialLength) {
      this.saveConfig();
      console.error(`[mcp] Removed local stdio server: ${idOrName}`);
      return true;
    }

    return false;
  }

  /**
   * Get all stdio servers.
   */
  getStdioServers(): StdioServerConfig[] {
    return this.loadConfig().stdioServers;
  }

  /**
   * Get a specific stdio server by ID or name.
   */
  getStdioServer(idOrName: string): StdioServerConfig | null {
    const servers = this.loadConfig().stdioServers;
    return (
      servers.find((s) => s.id === idOrName || s.name === idOrName) || null
    );
  }

  /**
   * Update a stdio server config.
   */
  updateStdioServer(
    idOrName: string,
    updates: Partial<Omit<StdioServerConfig, "id">>,
  ): boolean {
    const currentConfig = this.loadConfig();
    const server = currentConfig.stdioServers.find(
      (s) => s.id === idOrName || s.name === idOrName,
    );

    if (!server) return false;

    Object.assign(server, updates);
    this.saveConfig();

    console.error(`[mcp] Updated local stdio server: ${server.name}`);
    return true;
  }

  /**
   * Clear all stdio servers.
   */
  clearAll(): void {
    this.config = { stdioServers: [] };
    this.saveConfig();
    console.error("[mcp] Cleared all local stdio servers");
  }
}

// Singleton instance
export const localMcpConfig = new LocalMcpConfigManager();
