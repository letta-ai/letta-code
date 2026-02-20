import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string; data?: any }>;
  isError: boolean;
}

export class MCPStdioClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private messageId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private initialized = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
  ) {
    super();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[MCP] Spawning: ${this.command} ${this.args.join(' ')}`);
      
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: process.env,
      });

      if (!this.process || !this.process.stdin || !this.process.stdout) {
        reject(new Error('Failed to create stdio pipes'));
        return;
      }

      // Handle stdout (JSON-RPC responses)
      this.process.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            this.handleMessage(message);
          } catch (e) {
            console.error('[MCP] Failed to parse message:', line, e);
          }
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (data) => {
        console.error('[MCP stderr]', data.toString());
      });

      // Handle process exit
      this.process.on('exit', (code, signal) => {
        console.log(`[MCP] Process exited: code=${code}, signal=${signal}`);
        this.emit('exit', { code, signal });
      });

      // Handle process error
      this.process.on('error', (error) => {
        console.error('[MCP] Process error:', error);
        reject(error);
      });

      // Initialize MCP connection
      this.initialize()
        .then(() => {
          console.log('[MCP] Connected and initialized');
          resolve();
        })
        .catch(reject);
    });
  }

  private async initialize(): Promise<void> {
    // Send initialize request
    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: {
          listChanged: true,
        },
      },
      // change it from hardcoding 
      clientInfo: {
        name: 'letta-code',
        version: '0.14.16',
      },
    });

    // Send initialized notification
    this.sendNotification('notifications/initialized');

    this.initialized = true;
    this.emit('initialized');
  }

  private sendRequest(method: string, params: any): Promise<any> {
    // 1. Capture the stdin in a local variable
    const stdin = this.process?.stdin;

    // 2. Guard against null immediately
    if (!stdin) {
      throw new Error('MCP process not connected or stdin is unavailable');
    }

    const id = ++this.messageId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      stdin.write(JSON.stringify(request) + '\n');
    });
  }

  private sendNotification(method: string, params: any = {}): void {
    if (!this.process?.stdin) {
      throw new Error('MCP process not connected');
    }

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  private handleMessage(message: any): void {
    // Handle response to request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'MCP error'));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // Handle notifications
    if (message.method === 'notifications/message') {
      this.emit('message', message.params);
    } else if (message.method === 'notifications/roots/list_changed') {
      this.emit('rootsChanged');
    }
  }

  async listTools(): Promise<MCPTool[]> {
    const response = await this.sendRequest('tools/list', {});
    return response.tools || [];
  }

  async callTool(
    name: string,
    args: Record<string, any>,
  ): Promise<MCPToolResult> {
    console.log(`[MCP] Calling tool: ${name}`, args);
    
    const response = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });

    return response;
  }

  disconnect(): void {
    console.log('[MCP] Disconnecting...');
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this.pendingRequests.clear();
    this.initialized = false;
  }

  isConnected(): boolean {
    return this.process !== null && this.initialized;
  }
}