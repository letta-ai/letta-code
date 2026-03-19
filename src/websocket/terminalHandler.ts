/**
 * PTY terminal handler for listen mode.
 * Manages interactive terminal sessions spawned by the web UI.
 *
 * Uses Bun's native Bun.spawn terminal API when running under Bun,
 * and falls back to node-pty when running under Node.js (e.g. Electron).
 */

import * as os from "node:os";
import WebSocket from "ws";

// ── Runtime detection ──────────────────────────────────────────────────────
const IS_BUN = typeof Bun !== "undefined";

// ── Session types ──────────────────────────────────────────────────────────

interface TerminalSession {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  kill: () => void;
  readonly pid: number | undefined;
  readonly exited: Promise<number>;
  terminalId: string;
  spawnedAt: number;
}

const terminals = new Map<string, TerminalSession>();

/**
 * Get the default shell for the current platform.
 */
function getDefaultShell(): string {
  if (os.platform() === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  return process.env.SHELL || "/bin/zsh";
}

/**
 * Send a terminal message back to the web client via the device WebSocket.
 */
function sendTerminalMessage(
  socket: WebSocket,
  message: Record<string, unknown>,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

// ── Bun spawn ──────────────────────────────────────────────────────────────

function spawnBun(
  shell: string,
  cwd: string,
  cols: number,
  rows: number,
  terminal_id: string,
  socket: WebSocket,
): TerminalSession {
  let buffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const proc = Bun.spawn([shell], {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
    terminal: {
      cols: cols || 80,
      rows: rows || 24,
      data: (_terminal: unknown, data: Uint8Array) => {
        buffer += new TextDecoder().decode(data);
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            if (buffer.length > 0) {
              sendTerminalMessage(socket, {
                type: "terminal_output",
                terminal_id,
                data: buffer,
              });
              buffer = "";
            }
            flushTimer = null;
          }, 16);
        }
      },
    },
  });

  const terminal = (
    proc as unknown as {
      terminal: { write: (d: string) => void; resize: (c: number, r: number) => void; close: () => void };
    }
  ).terminal;

  if (!terminal) {
    throw new Error(
      "terminal object undefined on proc — Bun.Terminal API unavailable",
    );
  }

  return {
    write: (data) => terminal.write(data),
    resize: (c, r) => terminal.resize(c, r),
    close: () => terminal.close(),
    kill: () => proc.kill(),
    get pid() { return proc.pid; },
    exited: proc.exited.then((code) => code ?? 0),
    terminalId: terminal_id,
    spawnedAt: Date.now(),
  };
}

// ── node-pty spawn ─────────────────────────────────────────────────────────

function spawnNodePty(
  shell: string,
  cwd: string,
  cols: number,
  rows: number,
  terminal_id: string,
  socket: WebSocket,
): TerminalSession {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as typeof import("node-pty");

  let buffer = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const ptyProcess = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env: {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });

  ptyProcess.onData((data) => {
    buffer += data;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        if (buffer.length > 0) {
          sendTerminalMessage(socket, {
            type: "terminal_output",
            terminal_id,
            data: buffer,
          });
          buffer = "";
        }
        flushTimer = null;
      }, 16);
    }
  });

  let exitResolve: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });

  ptyProcess.onExit(({ exitCode }) => {
    exitResolve(exitCode ?? 0);
  });

  return {
    write: (data) => ptyProcess.write(data),
    resize: (c, r) => ptyProcess.resize(c, r),
    close: () => ptyProcess.kill(),
    kill: () => ptyProcess.kill(),
    get pid() { return ptyProcess.pid; },
    exited,
    terminalId: terminal_id,
    spawnedAt: Date.now(),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Spawn a new PTY terminal session.
 * Uses Bun.spawn under Bun, node-pty under Node.js / Electron.
 */
export function handleTerminalSpawn(
  msg: { terminal_id: string; cols: number; rows: number },
  socket: WebSocket,
  cwd: string,
): void {
  const { terminal_id, cols, rows } = msg;

  killTerminal(terminal_id);

  const shell = getDefaultShell();
  console.log(
    `[Terminal] Spawning PTY (${IS_BUN ? "bun" : "node-pty"}): shell=${shell}, cwd=${cwd}, cols=${cols}, rows=${rows}`,
  );

  try {
    const session = IS_BUN
      ? spawnBun(shell, cwd, cols, rows, terminal_id, socket)
      : spawnNodePty(shell, cwd, cols, rows, terminal_id, socket);

    terminals.set(terminal_id, session);
    console.log(
      `[Terminal] Session stored for terminal_id=${terminal_id}, pid=${session.pid}`,
    );

    const myPid = session.pid;
    session.exited.then((exitCode) => {
      const current = terminals.get(terminal_id);
      if (current && current.pid === myPid) {
        console.log(
          `[Terminal] PTY exited: terminal_id=${terminal_id}, pid=${myPid}, exitCode=${exitCode}`,
        );
        terminals.delete(terminal_id);
        sendTerminalMessage(socket, {
          type: "terminal_exited",
          terminal_id,
          exitCode,
        });
      }
    });

    sendTerminalMessage(socket, {
      type: "terminal_spawned",
      terminal_id,
      pid: session.pid,
    });
  } catch (error) {
    console.error("[Terminal] Failed to spawn PTY:", error);
    sendTerminalMessage(socket, {
      type: "terminal_exited",
      terminal_id,
      exitCode: 1,
    });
  }
}

/**
 * Write input data to a terminal session.
 */
export function handleTerminalInput(msg: {
  terminal_id: string;
  data: string;
}): void {
  terminals.get(msg.terminal_id)?.write(msg.data);
}

/**
 * Resize a terminal session.
 */
export function handleTerminalResize(msg: {
  terminal_id: string;
  cols: number;
  rows: number;
}): void {
  terminals.get(msg.terminal_id)?.resize(msg.cols, msg.rows);
}

/**
 * Kill a terminal session.
 */
export function handleTerminalKill(msg: { terminal_id: string }): void {
  const session = terminals.get(msg.terminal_id);
  if (session && Date.now() - session.spawnedAt < 2000) {
    console.log(
      `[Terminal] Ignoring kill for recently spawned session (age=${Date.now() - session.spawnedAt}ms)`,
    );
    return;
  }
  killTerminal(msg.terminal_id);
}

function killTerminal(terminalId: string): void {
  const session = terminals.get(terminalId);
  if (session) {
    console.log(
      `[Terminal] killTerminal: terminalId=${terminalId}, pid=${session.pid}`,
    );
    try {
      session.close();
    } catch {
      // may already be closed
    }
    try {
      session.kill();
    } catch {
      // may already be dead
    }
    terminals.delete(terminalId);
  }
}

/**
 * Kill all active terminal sessions.
 * Call on disconnect/cleanup.
 */
export function killAllTerminals(): void {
  for (const [id] of terminals) {
    killTerminal(id);
  }
}
