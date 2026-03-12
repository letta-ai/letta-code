/**
 * PTY terminal handler for listen mode.
 * Manages interactive terminal sessions spawned by the web UI.
 *
 * Uses Bun's native Bun.Terminal API (available since Bun v1.3.5)
 * for real PTY support without node-pty.
 */

import * as os from "node:os";
import WebSocket from "ws";

interface TerminalSession {
  process: ReturnType<typeof Bun.spawn>;
  terminal: {
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    close: () => void;
  };
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
 * Spawn a new PTY terminal session using Bun's native Terminal API.
 */
export function handleTerminalSpawn(
  msg: { terminal_id: string; cols: number; rows: number },
  socket: WebSocket,
  cwd: string,
): void {
  const { terminal_id, cols, rows } = msg;

  // Kill existing session with same ID if any
  killTerminal(terminal_id);

  const shell = getDefaultShell();

  console.log(
    `[Terminal] Spawning PTY: shell=${shell}, cwd=${cwd}, cols=${cols}, rows=${rows}`,
  );

  try {
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
        data: (() => {
          // Batch output chunks within a 16ms window into a single WS message
          // to avoid flooding the WebSocket with many small frames.
          let buffer = "";
          let flushTimer: ReturnType<typeof setTimeout> | null = null;

          return (_terminal: unknown, data: Uint8Array) => {
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
          };
        })(),
      },
    });

    // The terminal object is available on the proc when using the terminal option
    const terminal = (
      proc as unknown as { terminal: TerminalSession["terminal"] }
    ).terminal;

    console.log(
      `[Terminal] proc.pid=${proc.pid}, terminal=${typeof terminal}, keys=${Object.keys(proc as unknown as Record<string, unknown>).join(",")}`,
    );

    if (!terminal) {
      console.error(
        "[Terminal] terminal object is undefined on proc — Bun.Terminal API may not be available",
      );
      sendTerminalMessage(socket, {
        type: "terminal_exited",
        terminal_id,
        exitCode: 1,
      });
      return;
    }

    const session: TerminalSession = {
      process: proc,
      terminal,
      terminalId: terminal_id,
      spawnedAt: Date.now(),
    };
    terminals.set(terminal_id, session);
    console.log(
      `[Terminal] Session stored for terminal_id=${terminal_id}, map size=${terminals.size}`,
    );

    // Handle process exit — only clean up if this is still the active session
    // (a newer spawn may have replaced us in the map)
    const myPid = proc.pid;
    proc.exited.then((exitCode) => {
      const current = terminals.get(terminal_id);
      if (current && current.process.pid === myPid) {
        console.log(
          `[Terminal] PTY process exited: terminal_id=${terminal_id}, pid=${myPid}, exitCode=${exitCode}`,
        );
        terminals.delete(terminal_id);
        sendTerminalMessage(socket, {
          type: "terminal_exited",
          terminal_id,
          exitCode: exitCode ?? 0,
        });
      } else {
        console.log(
          `[Terminal] Stale PTY exit ignored: terminal_id=${terminal_id}, pid=${myPid} (current pid=${current?.process.pid})`,
        );
      }
    });

    sendTerminalMessage(socket, {
      type: "terminal_spawned",
      terminal_id,
      pid: proc.pid,
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
  const session = terminals.get(msg.terminal_id);
  if (session) {
    session.terminal.write(msg.data);
  }
}

/**
 * Resize a terminal session.
 */
export function handleTerminalResize(msg: {
  terminal_id: string;
  cols: number;
  rows: number;
}): void {
  const session = terminals.get(msg.terminal_id);
  if (session) {
    session.terminal.resize(msg.cols, msg.rows);
  }
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
      `[Terminal] killTerminal: terminalId=${terminalId}, pid=${session.process.pid}`,
    );
    try {
      session.terminal.close();
    } catch {
      // terminal may already be closed
    }
    session.process.kill();
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
