/**
 * PTY terminal handler for listen mode.
 * Manages interactive terminal sessions spawned by the web UI.
 *
 * Runtime strategy:
 * - Bun  → Bun.spawn with terminal option (native PTY, no node-pty needed)
 * - Node.js / Electron → node-pty (Bun.spawn unavailable; node-pty's libuv
 *   poll handles integrate correctly with Node.js but NOT with Bun's event loop)
 */

import { existsSync } from "node:fs";
import * as os from "node:os";
import WebSocket from "ws";

const IS_BUN = typeof Bun !== "undefined";

// 16ms debounce window for output batching; flush immediately at 64 KB
// to prevent unbounded string growth on high-throughput commands.
const FLUSH_INTERVAL_MS = 16;
const MAX_BUFFER_BYTES = 64 * 1024;

interface TerminalSession {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  pid: number;
  terminalId: string;
  connectionId: string;
  spawnedAt: number;
}

type NodePtyExitEvent = { exitCode?: number; signal?: number };

type NodePtyProcess = {
  pid: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (listener: (data: string) => void) => void;
  onExit: (listener: (event: NodePtyExitEvent) => void) => void;
};

type NodePtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ) => NodePtyProcess;
};

const terminals = new Map<string, TerminalSession>();

function getTerminalKey(connectionId: string, terminalId: string): string {
  return JSON.stringify([connectionId, terminalId]);
}

function getDefaultShell(): string {
  if (os.platform() === "win32") {
    return process.env.COMSPEC || "cmd.exe";
  }
  // $SHELL is absent in non-login contexts (e.g. cloud sandbox listeners
  // launched via session exec), and the shell it names may not exist in
  // minimal images — execvp would fail the PTY with ENOENT. Probe candidates
  // in order and fall back to /bin/sh, which every POSIX system provides.
  const candidates = [
    process.env.SHELL,
    os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash",
    "/bin/bash",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return "/bin/sh";
}

function sendTerminalMessage(
  socket: WebSocket,
  message: Record<string, unknown>,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

/** Create a flush-on-size-or-timer output batcher. */
function makeOutputBatcher(
  onFlush: (data: string) => void,
): (chunk: string) => void {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length > 0) {
      onFlush(buffer);
      buffer = "";
    }
  };

  return (chunk: string) => {
    buffer += chunk;
    if (buffer.length >= MAX_BUFFER_BYTES) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  };
}

// ── Bun spawn ──────────────────────────────────────────────────────────────

function spawnBun(
  shell: string,
  cwd: string,
  cols: number,
  rows: number,
  terminal_id: string,
  connectionId: string,
  socket: WebSocket,
): TerminalSession {
  const terminalKey = getTerminalKey(connectionId, terminal_id);
  const handleData = makeOutputBatcher((data) =>
    sendTerminalMessage(socket, { type: "terminal_output", terminal_id, data }),
  );

  const proc = Bun.spawn([shell], {
    cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: {
      cols: cols || 80,
      rows: rows || 24,
      data: (_t: unknown, chunk: Uint8Array) =>
        handleData(new TextDecoder().decode(chunk)),
    },
  });

  const terminal = (
    proc as unknown as {
      terminal: {
        write: (d: string) => void;
        resize: (c: number, r: number) => void;
        close: () => void;
      };
    }
  ).terminal;

  if (!terminal) {
    throw new Error("Bun.spawn terminal object missing — API unavailable");
  }

  proc.exited.then((exitCode) => {
    const current = terminals.get(terminalKey);
    if (current && current.pid === proc.pid) {
      terminals.delete(terminalKey);
      sendTerminalMessage(socket, {
        type: "terminal_exited",
        terminal_id,
        exitCode: exitCode ?? 0,
      });
    }
  });

  return {
    write: (d) => {
      try {
        terminal.write(d);
      } catch {}
    },
    resize: (c, r) => {
      try {
        terminal.resize(c, r);
      } catch {}
    },
    kill: () => {
      try {
        terminal.close();
      } catch {}
      try {
        proc.kill();
      } catch {}
    },
    pid: proc.pid,
    terminalId: terminal_id,
    connectionId,
    spawnedAt: Date.now(),
  };
}

// ── node-pty spawn (Node.js / Electron) ───────────────────────────────────

function spawnNodePty(
  shell: string,
  cwd: string,
  cols: number,
  rows: number,
  terminal_id: string,
  connectionId: string,
  socket: WebSocket,
): TerminalSession {
  const terminalKey = getTerminalKey(connectionId, terminal_id);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as NodePtyModule;

  const handleData = makeOutputBatcher((data) =>
    sendTerminalMessage(socket, { type: "terminal_output", terminal_id, data }),
  );

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

  ptyProcess.onData(handleData);

  ptyProcess.onExit(({ exitCode }: NodePtyExitEvent) => {
    const current = terminals.get(terminalKey);
    if (current && current.pid === ptyProcess.pid) {
      terminals.delete(terminalKey);
      sendTerminalMessage(socket, {
        type: "terminal_exited",
        terminal_id,
        exitCode: exitCode ?? 0,
      });
    }
  });

  return {
    write: (d) => {
      try {
        ptyProcess.write(d);
      } catch {}
    },
    resize: (c, r) => {
      try {
        ptyProcess.resize(c, r);
      } catch {}
    },
    kill: () => {
      try {
        ptyProcess.kill();
      } catch {}
    },
    pid: ptyProcess.pid,
    terminalId: terminal_id,
    connectionId,
    spawnedAt: Date.now(),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function handleTerminalSpawn(
  msg: { terminal_id: string; cols: number; rows: number },
  socket: WebSocket,
  cwd: string,
  connectionId = "legacy",
): void {
  const { terminal_id, cols, rows } = msg;
  const terminalKey = getTerminalKey(connectionId, terminal_id);

  // React Strict Mode fires mount→unmount→mount which produces spawn→kill→spawn
  // in rapid succession. The kill is already ignored (< 2s guard below), but the
  // second spawn would normally kill and restart. If the session is < 2s old and
  // still alive, reuse it and resend terminal_spawned instead.
  const existing = terminals.get(terminalKey);
  if (existing && Date.now() - existing.spawnedAt < 2000) {
    let alive = true;
    try {
      existing.write("\r");
    } catch {
      alive = false;
    }

    if (alive) {
      console.log(
        `[Terminal] Reusing session (age=${Date.now() - existing.spawnedAt}ms), pid=${existing.pid}`,
      );
      sendTerminalMessage(socket, {
        type: "terminal_spawned",
        terminal_id,
        pid: existing.pid,
      });
      return;
    }

    // Session dead — fall through to spawn a fresh one
    terminals.delete(terminalKey);
  }

  killTerminal(terminal_id, connectionId);

  const shell = getDefaultShell();
  console.log(
    `[Terminal] Spawning PTY (${IS_BUN ? "bun" : "node-pty"}): shell=${shell}, cwd=${cwd}, cols=${cols}, rows=${rows}`,
  );

  try {
    const session = IS_BUN
      ? spawnBun(shell, cwd, cols, rows, terminal_id, connectionId, socket)
      : spawnNodePty(shell, cwd, cols, rows, terminal_id, connectionId, socket);

    terminals.set(terminalKey, session);
    console.log(
      `[Terminal] Session stored for terminal_id=${terminal_id}, pid=${session.pid}`,
    );

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
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleTerminalInput(
  msg: {
    terminal_id: string;
    data: string;
  },
  connectionId = "legacy",
): void {
  terminals.get(getTerminalKey(connectionId, msg.terminal_id))?.write(msg.data);
}

export function handleTerminalResize(
  msg: {
    terminal_id: string;
    cols: number;
    rows: number;
  },
  connectionId = "legacy",
): void {
  terminals
    .get(getTerminalKey(connectionId, msg.terminal_id))
    ?.resize(msg.cols, msg.rows);
}

export function handleTerminalKill(
  msg: { terminal_id: string },
  connectionId = "legacy",
): void {
  const session = terminals.get(getTerminalKey(connectionId, msg.terminal_id));
  if (session && Date.now() - session.spawnedAt < 2000) {
    console.log(
      `[Terminal] Ignoring kill for recently spawned session (age=${Date.now() - session.spawnedAt}ms)`,
    );
    return;
  }
  killTerminal(msg.terminal_id, connectionId);
}

function killTerminal(terminalId: string, connectionId: string): void {
  const terminalKey = getTerminalKey(connectionId, terminalId);
  const session = terminals.get(terminalKey);
  if (session) {
    console.log(
      `[Terminal] killTerminal: terminalId=${terminalId}, pid=${session.pid}`,
    );
    session.kill();
    terminals.delete(terminalKey);
  }
}

export function killListenerConnectionTerminals(connectionId: string): void {
  for (const session of [...terminals.values()]) {
    if (session.connectionId === connectionId) {
      killTerminal(session.terminalId, connectionId);
    }
  }
}

export function killAllTerminals(): void {
  for (const session of [...terminals.values()]) {
    killTerminal(session.terminalId, session.connectionId);
  }
}
