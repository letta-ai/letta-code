/**
 * LSP Client - Handles JSON-RPC communication with LSP servers
 */

import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type {
  Diagnostic,
  InitializeParams,
  InitializeResult,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  LSPServerProcess,
} from "./types.js";

export interface LSPClientOptions {
  serverID: string;
  server: LSPServerProcess;
  rootUri: string;
}

/**
 * LSP Client that communicates with an LSP server via JSON-RPC over STDIO
 */
export class LSPClient extends EventEmitter {
  private process: LSPServerProcess;
  private rootUri: string;
  private stdin: Writable;
  private stdout: Readable;
  private requestId = 0;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private buffer = "";
  private initialized = false;
  private disposed = false;

  constructor(options: LSPClientOptions) {
    super();

    this.process = options.server;
    this.rootUri = options.rootUri;

    if (!this.process.process.stdin || !this.process.process.stdout) {
      throw new Error("LSP server process must have stdin/stdout");
    }

    this.stdin = this.process.process.stdin;
    this.stdout = this.process.process.stdout;

    this.setupListeners();
  }

  private setupListeners(): void {
    // Read from stdout and parse JSON-RPC messages
    this.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.stdout.on("error", (err) => {
      this.emit("error", err);
      // A broken stdout means no more responses will arrive — fail pending
      // requests instead of leaving their promises pending forever.
      this.rejectAllPending(
        new Error(`LSP stdout stream error: ${err.message}`),
      );
    });

    this.process.process.on("exit", (code) => {
      this.disposed = true;
      // The server process is gone, so in-flight requests will never get a
      // response — reject them so callers (including shutdown()) don't hang.
      this.rejectAllPending(
        new Error(`LSP server exited (code ${code ?? "null"})`),
      );
      this.emit("exit", code);
    });
  }

  /**
   * Reject every outstanding request with the given error and clear the table.
   * Safe to call multiple times — once the pending map is empty it's a no-op.
   */
  private rejectAllPending(error: Error): void {
    if (this.pendingRequests.size === 0) return;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private processBuffer(): void {
    while (true) {
      // Find Content-Length header
      const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n/);
      if (!headerMatch?.[1]) break;

      const contentLength = Number.parseInt(headerMatch[1], 10);
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + contentLength) break;

      // Extract message
      const messageText = this.buffer.substring(
        messageStart,
        messageStart + contentLength,
      );
      this.buffer = this.buffer.substring(messageStart + contentLength);

      try {
        const message = JSON.parse(messageText);
        this.handleMessage(message);
      } catch (error) {
        this.emit("error", new Error(`Failed to parse LSP message: ${error}`));
      }
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    // Handle responses to our requests
    if ("id" in message && message.id !== undefined) {
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`LSP Error: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // Handle notifications from server
    const notification = message as JsonRpcNotification;
    if (notification.method === "textDocument/publishDiagnostics") {
      const params = notification.params as {
        uri: string;
        diagnostics: Diagnostic[];
      };
      this.emit("diagnostics", params.uri, params.diagnostics);
    }

    this.emit("notification", notification);
  }

  private sendRequest<T>(method: string, params?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      // If the server is already gone, fail fast instead of enqueueing a
      // request that can never be written or answered.
      if (this.disposed) {
        reject(new Error("LSP server has exited"));
        return;
      }
      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });

      this.sendMessage(request);
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.sendMessage(notification);
  }

  private sendMessage(message: JsonRpcRequest | JsonRpcNotification): void {
    if (this.disposed) {
      // Server process is gone — writing to its stdin would throw. Drop the
      // message; any request waiting on a response was already rejected by
      // the exit/error handler.
      return;
    }
    const content = JSON.stringify(message);
    const header = `Content-Length: ${content.length}\r\n\r\n`;
    this.stdin.write(header + content);
  }

  /**
   * Initialize the LSP server
   */
  async initialize(): Promise<InitializeResult> {
    const params: InitializeParams = {
      processId: process.pid,
      rootUri: `file://${this.rootUri}`,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
          },
        },
      },
      initializationOptions: this.process.initialization,
    };

    const result = await this.sendRequest<InitializeResult>(
      "initialize",
      params,
    );

    // Send initialized notification
    this.sendNotification("initialized", {});
    this.initialized = true;

    return result;
  }

  /**
   * Notify server that a document was opened
   */
  didOpen(
    uri: string,
    languageId: string,
    version: number,
    text: string,
  ): void {
    if (!this.initialized) return;

    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version,
        text,
      },
    });
  }

  /**
   * Notify server that a document was changed
   */
  didChange(uri: string, version: number, text: string): void {
    if (!this.initialized) return;

    this.sendNotification("textDocument/didChange", {
      textDocument: {
        uri,
        version,
      },
      contentChanges: [
        {
          text,
        },
      ],
    });
  }

  /**
   * Notify server that a document was closed
   */
  didClose(uri: string): void {
    if (!this.initialized) return;

    this.sendNotification("textDocument/didClose", {
      textDocument: {
        uri,
      },
    });
  }

  /**
   * Shutdown the LSP server gracefully
   */
  async shutdown(): Promise<void> {
    if (this.initialized) {
      await this.sendRequest("shutdown");
      this.sendNotification("exit");
    }
    this.process.process.kill();
  }
}
