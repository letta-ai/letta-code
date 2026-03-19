/**
 * PTY terminal handler for listen mode.
 * Manages interactive terminal sessions spawned by the web UI.
 *
 * Uses node-pty for real PTY support across all runtimes (Bun, Node.js, Electron).
 */

import * as os from "node:os";
import WebSocket from "ws";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require("node-pty") as typeof import("node-pty");

interface TerminalSession {
  ptyProcess: import("node-pty").IPty;
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

/**
 * Spawn a new PTY terminal session.
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
    `[Terminal] Spawning PTY: shell=${shell}, cwd=${cwd}, cols=${cols}, rows=${rows}`,
  );

  try {
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

    const myPid = ptyProcess.pid;

    ptyProcess.onExit(({ exitCode }) => {
      const current = terminals.get(terminal_id);
      if (current && current.ptyProcess.pid === myPid) {
        console.log(
          `[Terminal] PTY exited: terminal_id=${terminal_id}, pid=${myPid}, exitCode=${exitCode}`,
        );
        terminals.delete(terminal_id);
        sendTerminalMessage(socket, {
          type: "terminal_exited",
          terminal_id,
          exitCode: exitCode ?? 0,
        });
      }
    });

    terminals.set(terminal_id, {
      ptyProcess,
      terminalId: terminal_id,
      spawnedAt: Date.now(),
    });

    console.log(
      `[Terminal] Session stored for terminal_id=${terminal_id}, pid=${myPid}`,
    );

    sendTerminalMessage(socket, {
      type: "terminal_spawned",
      terminal_id,
      pid: myPid,
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
  terminals.get(msg.terminal_id)?.ptyProcess.write(msg.data);
}

/**
 * Resize a terminal session.
 */
export function handleTerminalResize(msg: {
  terminal_id: string;
  cols: number;
  rows: number;
}): void {
  terminals.get(msg.terminal_id)?.ptyProcess.resize(msg.cols, msg.rows);
}

/**
 * Kill a terminal session.
 */
export function handleTerminalKill(msg: { terminal_id: string }): void {
  const session = terminals.get(msg.terminal_id);
  // Ignore kill if the session was spawned very recently (< 2s).
  // This handles the React Strict Mode race where cleanup's kill arrives
  // after the remount's spawn due to async WS relay latency.
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
      `[Terminal] killTerminal: terminalId=${terminalId}, pid=${session.ptyProcess.pid}`,
    );
    try {
      session.ptyProcess.kill();
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
