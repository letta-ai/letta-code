/**
 * Always-on file logger for letta remote sessions.
 * Writes to ~/.letta/logs/remote/{timestamp}.log regardless of --debug mode.
 * Debug mode additionally prints to console; this file always captures the log.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REMOTE_LOG_DIR = join(homedir(), ".letta", "logs", "remote");
const MAX_LOG_FILES = 10;

function formatTimestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function pruneOldLogs(): void {
  try {
    if (!existsSync(REMOTE_LOG_DIR)) return;
    const files = readdirSync(REMOTE_LOG_DIR)
      .filter((f) => f.endsWith(".log"))
      .sort();
    if (files.length >= MAX_LOG_FILES) {
      const toDelete = files.slice(0, files.length - MAX_LOG_FILES + 1);
      for (const file of toDelete) {
        try {
          unlinkSync(join(REMOTE_LOG_DIR, file));
        } catch {
          // best-effort cleanup
        }
      }
    }
  } catch {
    // best-effort cleanup
  }
}

export class RemoteSessionLog {
  readonly path: string;
  private dirCreated = false;

  constructor() {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    this.path = join(REMOTE_LOG_DIR, `${stamp}.log`);
  }

  /** Must be called once at startup to create the directory and prune old logs. */
  init(): void {
    this.ensureDir();
    pruneOldLogs();
  }

  /** Log a line to the file (best-effort, sync). */
  log(message: string): void {
    const line = `[${formatTimestamp()}] ${message}\n`;
    this.appendLine(line);
  }

  /** Log a WS event in the same format as debugWsLogger. */
  wsEvent(
    direction: "send" | "recv",
    label: "client" | "protocol" | "control" | "lifecycle",
    event: unknown,
  ): void {
    const arrow = direction === "send" ? "\u2192 send" : "\u2190 recv";
    const tag = label === "client" ? "" : ` (${label})`;
    const json = JSON.stringify(event);
    this.log(`${arrow}${tag}  ${json}`);
  }

  private appendLine(line: string): void {
    this.ensureDir();
    try {
      appendFileSync(this.path, line, { encoding: "utf8" });
    } catch {
      // best-effort
    }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    try {
      if (!existsSync(REMOTE_LOG_DIR)) {
        mkdirSync(REMOTE_LOG_DIR, { recursive: true });
      }
      this.dirCreated = true;
    } catch {
      // silently ignore
    }
  }
}
