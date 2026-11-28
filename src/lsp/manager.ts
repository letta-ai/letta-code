import * as path from "node:path";
import { LSPClient } from "./client.js";
import type { Diagnostic, LSPServerInfo } from "./types.js";

interface ActiveServer {
  client: LSPClient;
  rootUri: string;
  extensions: string[];
}

export class LSPManager {
  private static instance: LSPManager | null = null;
  private servers = new Map<string, ActiveServer>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private openDocuments = new Map<string, { version: number; uri: string }>();
  private serverDefinitions: LSPServerInfo[] = [];
  private enabled = false;

  private constructor() {}

  static getInstance(): LSPManager {
    if (!LSPManager.instance) {
      LSPManager.instance = new LSPManager();
    }
    return LSPManager.instance;
  }

  async initialize(projectRoot: string): Promise<void> {
    if (!process.env.LETTA_ENABLE_LSP) {
      return;
    }

    this.enabled = true;

    const { SERVERS } = await import("@/lsp/servers/index.js");
    this.serverDefinitions = SERVERS;

    console.log(`[LSP] Initialized for project: ${projectRoot}`);
  }

  private async getOrStartServer(filePath: string): Promise<LSPClient | null> {
    if (!this.enabled) return null;

    const ext = path.extname(filePath).toLowerCase();

    const serverDef = this.serverDefinitions.find((s) =>
      s.extensions.includes(ext),
    );

    if (!serverDef) {
      return null;
    }

    const existing = this.servers.get(serverDef.id);
    if (existing) {
      return existing.client;
    }

    try {
      const { spawn } = await import("node:child_process");
      const rootUri = process.cwd();

      if (serverDef.autoInstall) {
        const isAvailable = await serverDef.autoInstall.check();
        if (!isAvailable) {
          console.log(
            `[LSP] ${serverDef.id} not found, attempting auto-install...`,
          );
          await serverDef.autoInstall.install();
        }
      }

      const command = serverDef.command[0];
      if (!command) {
        console.error(`[LSP] ${serverDef.id} has no command configured`);
        return null;
      }

      const proc = spawn(command, serverDef.command.slice(1), {
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
      const { promises: fs } = await import("node:fs");
      const text = await fs.readFile(absolutePath, "utf-8");
      const languageId = this.getLanguageId(filePath);

      client.didOpen(uri, languageId, 1, text);
      this.openDocuments.set(absolutePath, { version: 1, uri });
    } else if (changed) {
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

  private updateDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    const filePath = uri.replace("file://", "");
    this.diagnostics.set(filePath, diagnostics);
  }

  getDiagnostics(filePath?: string): Diagnostic[] {
    if (!this.enabled) return [];

    if (filePath) {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
      return this.diagnostics.get(absolutePath) || [];
    }

    const all: Diagnostic[] = [];
    for (const diagnostics of this.diagnostics.values()) {
      all.push(...diagnostics);
    }
    return all;
  }

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

  async shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const server of this.servers.values()) {
      promises.push(server.client.shutdown());
    }
    const results = await Promise.allSettled(promises);
    this.servers.clear();
    this.diagnostics.clear();
    this.openDocuments.clear();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

export const lspManager = LSPManager.getInstance();
