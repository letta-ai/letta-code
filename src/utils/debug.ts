// src/utils/debug.ts
// Debug logging utility.
//
// Screen output: controlled by LETTA_DEBUG=1 (or LETTA_DEBUG_FILE for a custom path).
// File output:   always written to ~/.letta/logs/debug/{agent-id}/{session-id}.log
//                once debugLogFile.init() has been called.  Before init, lines are
//                silently dropped (no file path yet).

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";

// ---------------------------------------------------------------------------
// Screen-output helpers (unchanged behaviour)
// ---------------------------------------------------------------------------

/**
 * Check if debug mode is enabled via LETTA_DEBUG env var
 * Set LETTA_DEBUG=1 or LETTA_DEBUG=true to enable debug logging
 */
export function isDebugEnabled(): boolean {
  const debug = process.env.LETTA_DEBUG;
  return debug === "1" || debug === "true";
}

function getDebugFile(): string | null {
  const path = process.env.LETTA_DEBUG_FILE;
  return path && path.trim().length > 0 ? path : null;
}

/** Print to screen (or LETTA_DEBUG_FILE). Only called when LETTA_DEBUG=1. */
function printDebugLine(line: string): void {
  const debugFile = getDebugFile();
  if (debugFile) {
    try {
      appendFileSync(debugFile, line, { encoding: "utf8" });
      return;
    } catch {
      // Fall back to console if file write fails
    }
  }
  console.log(line.trimEnd());
}

// ---------------------------------------------------------------------------
// Always-on debug log file
// ---------------------------------------------------------------------------

const DEBUG_LOG_DIR = join(homedir(), ".letta", "logs", "debug");
const MAX_SESSION_FILES = 5;
const DEFAULT_TAIL_LINES = 50;

class DebugLogFile {
  private logPath: string | null = null;
  private agentDir: string | null = null;
  private dirCreated = false;

  /**
   * Initialize for an agent + session. Call once at session start.
   * After this, every debugLog/debugWarn call is persisted to disk.
   * Respects LETTA_CODE_TELEM=0 — skips file logging when telemetry is disabled.
   */
  init(agentId: string, sessionId: string): void {
    const telem = process.env.LETTA_CODE_TELEM;
    if (telem === "0" || telem === "false") return;

    this.agentDir = join(DEBUG_LOG_DIR, agentId);
    this.logPath = join(this.agentDir, `${sessionId}.log`);
    this.dirCreated = false;
    this.pruneOldSessions();
  }

  /** Append a single line to the log file (best-effort, sync). */
  appendLine(line: string): void {
    if (!this.logPath) return;
    this.ensureDir();
    try {
      appendFileSync(this.logPath, line, { encoding: "utf8" });
    } catch {
      // Best-effort — never crash the app for debug logging
    }
  }

  /** Read the last N lines from the current log file. */
  getTail(maxLines = DEFAULT_TAIL_LINES): string | undefined {
    if (!this.logPath) return undefined;
    try {
      if (!existsSync(this.logPath)) return undefined;
      const content = readFileSync(this.logPath, "utf8");
      const lines = content.trimEnd().split("\n");
      return lines.slice(-maxLines).join("\n");
    } catch {
      return undefined;
    }
  }

  private ensureDir(): void {
    if (this.dirCreated || !this.agentDir) return;
    try {
      if (!existsSync(this.agentDir)) {
        mkdirSync(this.agentDir, { recursive: true });
      }
      this.dirCreated = true;
    } catch {
      // Silently ignore — will retry on next append
    }
  }

  private pruneOldSessions(): void {
    if (!this.agentDir) return;
    try {
      if (!existsSync(this.agentDir)) return;
      const files = readdirSync(this.agentDir)
        .filter((f) => f.endsWith(".log"))
        .sort();
      if (files.length >= MAX_SESSION_FILES) {
        const toDelete = files.slice(0, files.length - MAX_SESSION_FILES + 1);
        for (const file of toDelete) {
          try {
            unlinkSync(join(this.agentDir, file));
          } catch {
            // best-effort cleanup
          }
        }
      }
    } catch {
      // best-effort cleanup
    }
  }
}

/** Singleton — import and call init() once per session. */
export const debugLogFile = new DebugLogFile();

// ---------------------------------------------------------------------------
// Core write function
// ---------------------------------------------------------------------------

function writeDebugLine(
  prefix: string,
  message: string,
  args: unknown[],
): void {
  const ts = new Date().toISOString();
  const body = format(`[${prefix}] ${message}`, ...args);
  const line = `${ts} ${body}\n`;

  // Always persist to the session log file
  debugLogFile.appendLine(line);

  // Screen output only when LETTA_DEBUG is on
  if (isDebugEnabled()) {
    printDebugLine(line);
  }
}

// ---------------------------------------------------------------------------
// Public API (unchanged signatures)
// ---------------------------------------------------------------------------

/**
 * Log a debug message. Always written to the session log file.
 * Only printed to screen when LETTA_DEBUG=1.
 */
export function debugLog(
  prefix: string,
  message: string,
  ...args: unknown[]
): void {
  writeDebugLine(prefix, message, args);
}

/**
 * Log a debug warning. Always written to the session log file.
 * Only printed to screen when LETTA_DEBUG=1.
 */
export function debugWarn(
  prefix: string,
  message: string,
  ...args: unknown[]
): void {
  writeDebugLine(prefix, `WARN: ${message}`, args);
}
