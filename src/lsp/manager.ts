/**
 * LSP Manager - Orchestrates multiple LSP servers and maintains diagnostics
 */

import * as path from "node:path";
import { LSPClient } from "./client.js";
import type { Diagnostic, LSPServerInfo } from "./types.js";

interface ActiveServer {
  client: LSPClient;
  rootUri: string;
  extensions: string[];
}

/**
 * Global LSP Manager singleton
 * Manages LSP servers and aggregates diagnostics
 */
export class LSPManager {
  private static instance: LSPManager | null = null;
  private servers = new Map<string, ActiveServer>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private openDocuments = new Map<string, { version: number; uri: string }>();
  private serverDefinitions: LSPServerInfo[] = [];
  private enabled = false;

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): LSPManager {
    if (!LSPManager.instance) {
      LSPManager.instance = new LSPManager();
    }
    return LSPManager.instance;
  }

  /**
   * Initialize LSP system for a project
   */
  async initialize(projectRoot: string): Promise<void> {
    // Check if LSP is enabled
    if (!process.env.LETTA_ENABLE_LSP) {
      return;
    }

    this.enabled = true;

    // Load server definitions
    const { SERVERS } = await import("./servers/index.js");
    this.serverDefinitions = SERVERS;

    console.log(`[LSP] Initialized for project: ${projectRoot}`);
  }

  /**
   * Get or start LSP server for a file
   */
  private async getOrStartServer(filePath: string): Promise<LSPClient | null> {
    if (!this.enabled) return null;

    const ext = path.extname(filePath).toLowerCase();

    // Find server definition for this file extension
    const serverDef = this.serverDefinitions.find((s) =>
      s.extensions.includes(ext),
    );

    if (!serverDef) {
      return null;
    }

    // Check if server is already running
    const existing = this.servers.get(serverDef.id);
    if (existing) {
      return existing.client;
    }

    // Start new server
    try {
      const { spawn } = await import("node:child_process");
      const rootUri = process.cwd();

      // Check if server binary is available
      if (serverDef.autoInstall) {
        const isAvailable = await serverDef.autoInstall.check();
        if (!isAvailable) {
          console.log(
            `[LSP] ${serverDef.id} not found, attempting auto-install...`,
          );
          await serverDef.autoInstall.install();
        }
      }

      const proc = spawn(serverDef.command[0], serverDef.command.slice(1), {
        cwd: rootUri,
        env: {
          ...process.env,
          ...serverDef.env,
        },
      });

      const client = new LSPClient({
        serverID: serverDef.id,
        server: {
          process: proc,
          initialization: serverDef.initialization,
        },
        rootUri,
      });

      // Listen for diagnostics
      client.on("diagnostics", (uri: string, diagnostics: Diagnostic[]) => {
        this.updateDiagnostics(uri, diagnostics);
      });

      client.on("error", (error: Error) => {
        console.error(`[LSP] ${serverDef.id} error:`, error);
      });

      client.on("exit", (code: number | null) => {
        console.log(`[LSP] ${serverDef.id} exited with code ${code}`);
        this.servers.delete(serverDef.id);
      });

      // Initialize the server
      await client.initialize();

      this.servers.set(serverDef.id, {
        client,
        rootUri,
        extensions: serverDef.extensions,
      });

      console.log(`[LSP] Started ${serverDef.id}`);

      return client;
    } catch (error) {
      console.error(`[LSP] Failed to start ${serverDef.id}:`, error);
      return null;
    }
  }

  /**
   * Notify LSP that a file was opened or touched
   */
  async touchFile(filePath: string, changed: boolean): Promise<void> {
    if (!this.enabled) return;

    const client = await this.getOrStartServer(filePath);
    if (!client) return;

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    const uri = `file://${absolutePath}`;

    const existing = this.openDocuments.get(absolutePath);

    if (!existing) {
      // Open document for the first time
      const { promises: fs } = await import("node:fs");
      const text = await fs.readFile(absolutePath, "utf-8");
      const languageId = this.getLanguageId(filePath);

      client.didOpen(uri, languageId, 1, text);
      this.openDocuments.set(absolutePath, { version: 1, uri });
    } else if (changed) {
      // Document was changed
      const { promises: fs } = await import("node:fs");
      const text = await fs.readFile(absolutePath, "utf-8");
      const newVersion = existing.version + 1;

      client.didChange(uri, newVersion, text);
      this.openDocuments.set(absolutePath, {
        version: newVersion,
        uri,
      });
    }
  }

  /**
   * Update diagnostics for a file
   */
  private updateDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    // Convert file:// URI to absolute path
    const filePath = uri.replace("file://", "");
    this.diagnostics.set(filePath, diagnostics);
  }

  /**
   * Get diagnostics for a specific file
   */
  getDiagnostics(filePath?: string): Diagnostic[] {
    if (!this.enabled) return [];

    if (filePath) {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
      return this.diagnostics.get(absolutePath) || [];
    }

    // Return all diagnostics
    const all: Diagnostic[] = [];
    for (const diagnostics of this.diagnostics.values()) {
      all.push(...diagnostics);
    }
    return all;
  }

  /**
   * Get language ID for a file
   */
  private getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".py": "python",
      ".pyi": "python",
      ".go": "go",
      ".rs": "rust",
      ".java": "java",
      ".c": "c",
      ".cpp": "cpp",
      ".h": "c",
      ".hpp": "cpp",
    };
    return languageMap[ext] || "plaintext";
  }

  /**
   * Shutdown all LSP servers
   */
  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const server of this.servers.values()) {
      promises.push(server.client.shutdown());
    }
    await Promise.all(promises);
    this.servers.clear();
    this.diagnostics.clear();
    this.openDocuments.clear();
  }
}

// Export singleton instance
export const lspManager = LSPManager.getInstance();
