/**
 * File logger for letta server sessions.
 * Writes lifecycle/status lines to ~/.letta/logs/remote/{timestamp}.log.
 * WS frame logging is optional and controlled by the caller.
 *
 * Disk usage is bounded two ways: the directory is pruned to the newest
 * MAX_LOG_FILES files, and each file rotates to a fresh timestamped file once
 * it exceeds MAX_LOG_BYTES. Rotation also prunes, so worst-case directory size
 * is roughly MAX_LOG_FILES * MAX_LOG_BYTES. Without the size cap, one
 * long-running listener session (e.g. a Cloud managed sandbox with `--debug`,
 * which logs every WS frame) can grow a single file until the disk fills.
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
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB per session file

function formatTimestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function formatFileTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function pruneOldLogs(dir: string, maxFiles: number): void {
  try {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .sort();
    if (files.length >= maxFiles) {
      const toDelete = files.slice(0, files.length - maxFiles + 1);
      for (const file of toDelete) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          // best-effort cleanup
        }
      }
    }
  } catch {
    // best-effort cleanup
  }
}

interface RemoteSessionLogOptions {
  /** Override the log directory (tests). Defaults to ~/.letta/logs/remote. */
  dir?: string;
  /** Override the per-file size cap in bytes (tests). */
  maxBytes?: number;
  /** Override the retained file count (tests). */
  maxFiles?: number;
}

export class RemoteSessionLog {
  path: string;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private bytesWritten = 0;
  private rotation = 0;
  private dirCreated = false;

  constructor(options: RemoteSessionLogOptions = {}) {
    this.dir = options.dir ?? REMOTE_LOG_DIR;
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.maxFiles = options.maxFiles ?? MAX_LOG_FILES;
    this.path = this.freshPath();
  }

  /** Must be called once at startup to create the directory and prune old logs. */
  init(): void {
    this.ensureDir();
    pruneOldLogs(this.dir, this.maxFiles);
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
    const arrow = direction === "send" ? "→ send" : "← recv";
    const tag = label === "client" ? "" : ` (${label})`;
    const json = JSON.stringify(event);
    this.log(`${arrow}${tag}  ${json}`);
  }

  private freshPath(): string {
    const stamp = formatFileTimestamp(new Date());
    const suffix = this.rotation > 0 ? `.${this.rotation}` : "";
    return join(this.dir, `${stamp}${suffix}.log`);
  }

  /** Start a new timestamped file once the current one exceeds the size cap. */
  private rotate(): void {
    const previous = this.path;
    this.rotation += 1;
    this.path = this.freshPath();
    // Same-millisecond rotations can collide; bump the suffix until unique.
    while (existsSync(this.path)) {
      this.rotation += 1;
      this.path = this.freshPath();
    }
    this.bytesWritten = 0;
    pruneOldLogs(this.dir, this.maxFiles);
    const previousName = previous.slice(this.dir.length + 1);
    this.appendLine(
      `[${formatTimestamp()}] rotated from ${previousName} after it exceeded ${this.maxBytes} bytes\n`,
    );
  }

  private appendLine(line: string): void {
    this.ensureDir();
    if (this.bytesWritten >= this.maxBytes) {
      this.rotate();
    }
    try {
      appendFileSync(this.path, line, { encoding: "utf8" });
      this.bytesWritten += Buffer.byteLength(line, "utf8");
    } catch {
      // best-effort
    }
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
      }
      this.dirCreated = true;
    } catch {
      // silently ignore
    }
  }
}
