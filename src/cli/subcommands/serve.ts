/**
 * CLI subcommand: letta serve
 *
 * Starts an HTTP + WebSocket server that bridges incoming WebSocket
 * connections to headless letta-code sessions. Each WS connection
 * gets its own subprocess running in bidirectional JSON mode.
 *
 * This allows the Letta Code SDK (WebSocketTransport) or any WS
 * client to drive agents remotely using the same WireMessage protocol
 * used by the stdio transport.
 *
 * Usage:
 *   letta serve --port 8374
 *   letta serve --port 8374 --host 0.0.0.0
 *
 * SDK connection:
 *   const session = connect({ url: "ws://localhost:8374?agent=agent-xxx" });
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";

// ─── Types ───────────────────────────────────────────────────

interface Connection {
  id: string;
  ws: WebSocket;
  child: ChildProcess;
  agentId?: string;
  conversationId?: string;
  connectedAt: number;
}

// ─── Logging ─────────────────────────────────────────────────

function log(tag: string, ...args: unknown[]) {
  const now = new Date();
  const ts = now.toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}]`, ...args);
}

// ─── CLI Entry Point ─────────────────────────────────────────

export async function runServeSubcommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p", default: "8374" },
      host: { type: "string", default: "0.0.0.0" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log("Usage: letta serve [--port <port>] [--host <host>]\n");
    console.log("Start a WebSocket server for remote SDK connections.\n");
    console.log("Options:");
    console.log("  --port, -p  Port to listen on (default: 8374)");
    console.log("  --host      Host to bind to (default: 0.0.0.0)");
    console.log("  --help, -h  Show this help message");
    console.log("\nSDK usage:");
    console.log('  connect({ url: "ws://localhost:8374?agent=agent-xxx" })');
    return 0;
  }

  const port = Number.parseInt(values.port ?? "8374", 10);
  const host = values.host ?? "0.0.0.0";

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${values.port}`);
    return 1;
  }

  return startServer(port, host);
}

// ─── Server ──────────────────────────────────────────────────

async function startServer(port: number, host: string): Promise<number> {
  const connections = new Map<string, Connection>();
  let connectionCounter = 0;

  // Find the CLI entry point (same file that runs `letta`)
  const cliPath = findCli();
  log("serve", `CLI path: ${cliPath}`);

  // Create HTTP server for health check + WS upgrade
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          connections: connections.size,
          uptime: process.uptime(),
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // WebSocket server
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const connId = `conn-${++connectionCounter}`;
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );

    // Extract agent/conversation from query params
    const agentId = url.searchParams.get("agent") || undefined;
    const conversationId = url.searchParams.get("conversation") || undefined;
    const newConversation = url.searchParams.get("new") === "true";
    const includePartialMessages =
      url.searchParams.get("include-partial-messages") === "true";

    log(
      "connect",
      `${connId}: agent=${agentId || "default"} conversation=${conversationId || "new"} new=${newConversation}`,
    );

    // Build CLI args for headless bidirectional mode
    const args = buildChildArgs({
      agentId,
      conversationId,
      newConversation,
      includePartialMessages,
    });

    // Spawn headless child process
    const child = spawn("node", [cliPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const conn: Connection = {
      id: connId,
      ws,
      child,
      agentId,
      conversationId,
      connectedAt: Date.now(),
    };
    connections.set(connId, conn);

    log("connect", `${connId}: spawned child pid=${child.pid}`);

    // ─── Child stdout → WebSocket ────────────────────────

    if (child.stdout) {
      const rl = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        if (!line.trim()) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(line); // Already JSON, forward as-is
        }
      });
    }

    // Log child stderr for debugging
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          log("child-stderr", `${connId}: ${msg.slice(0, 500)}`);
        }
      });
    }

    // ─── WebSocket → Child stdin ─────────────────────────

    ws.on("message", (data) => {
      if (!child.stdin || child.killed) return;
      const raw = typeof data === "string" ? data : data.toString();
      child.stdin.write(`${raw}\n`);
    });

    // ─── Cleanup ─────────────────────────────────────────

    ws.on("close", () => {
      log("disconnect", `${connId}: WebSocket closed`);
      cleanup(connId, connections);
    });

    ws.on("error", (err) => {
      log("ws-error", `${connId}: ${err.message}`);
      cleanup(connId, connections);
    });

    child.on("close", (code, signal) => {
      log(
        "child-exit",
        `${connId}: pid=${child.pid} code=${code} signal=${signal}`,
      );
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Agent process exited");
      }
      connections.delete(connId);
    });

    child.on("error", (err) => {
      log("child-error", `${connId}: ${err.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, "Agent process error");
      }
      connections.delete(connId);
    });
  });

  // ─── Graceful shutdown ─────────────────────────────────

  const shutdown = () => {
    log("serve", "Shutting down...");
    for (const [id, conn] of connections) {
      log("shutdown", `Closing ${id}`);
      conn.child.kill();
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close(1001, "Server shutting down");
      }
    }
    connections.clear();
    wss.close();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ─── Start listening ───────────────────────────────────

  return new Promise<number>((resolve) => {
    server.listen(port, host, () => {
      log("serve", `Letta Code serve listening on ws://${host}:${port}`);
      log("serve", `Health check: http://${host}:${port}/health`);
      log("serve", "Press Ctrl+C to stop\n");

      // Keep running until shutdown (resolve is never called for normal operation)
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use`);
        resolve(1);
      } else {
        console.error(`Server error: ${err.message}`);
        resolve(1);
      }
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────

function buildChildArgs(opts: {
  agentId?: string;
  conversationId?: string;
  newConversation?: boolean;
  includePartialMessages?: boolean;
}): string[] {
  const args: string[] = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    // Default to bypass permissions for remote SDK connections
    "--yolo",
  ];

  if (opts.conversationId) {
    args.push("--conversation", opts.conversationId);
  } else if (opts.agentId) {
    args.push("--agent", opts.agentId);
    if (opts.newConversation) {
      args.push("--new");
    }
  }

  if (opts.includePartialMessages) {
    args.push("--include-partial-messages");
  }

  return args;
}

function cleanup(connId: string, connections: Map<string, Connection>) {
  const conn = connections.get(connId);
  if (!conn) return;

  if (!conn.child.killed) {
    conn.child.kill();
  }
  if (conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.close();
  }
  connections.delete(connId);
}

function findCli(): string {
  const { existsSync } = require("node:fs") as typeof import("node:fs");

  // Strategy 1: LETTA_CLI_PATH env var
  if (process.env.LETTA_CLI_PATH && existsSync(process.env.LETTA_CLI_PATH)) {
    return process.env.LETTA_CLI_PATH;
  }

  // Strategy 2: Relative to this file (we're inside the letta-code package)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // In dev: src/cli/subcommands/serve.ts → ../../.. → repo root/letta.js
  // In prod: dist/cli/subcommands/serve.js → ../../.. → package root/letta.js
  const candidates = [
    join(__dirname, "../../../letta.js"),
    join(__dirname, "../../letta.js"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }

  // Strategy 3: Try resolving from node_modules
  try {
    const { createRequire } =
      require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    return req.resolve("@letta-ai/letta-code");
  } catch {
    // Fallback: assume `letta.js` is in process.cwd()
    return join(process.cwd(), "letta.js");
  }
}
