import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import { redactWsEventForLogging } from "./ws-event-redaction";

const REMOTE_LOG_DIR = join(resolveGlobalConfigDir(), "logs", "remote");
const MAX_LOG_FILES = 10;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

export function formatTimestamp(): string {
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
        } catch {}
      }
    }
  } catch {}
}

interface RemoteSessionLogOptions {
  dir?: string;
  maxBytes?: number;
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

  init(): void {
    this.ensureDir();
    pruneOldLogs(this.dir, this.maxFiles);
  }

  log(message: string): void {
    const line = `[${formatTimestamp()}] ${message}\n`;
    this.appendLine(line);
  }

  wsEvent(
    direction: "send" | "recv",
    label: "client" | "protocol" | "control" | "lifecycle",
    event: unknown,
  ): void {
    const arrow = direction === "send" ? "→ send" : "← recv";
    const tag = label === "client" ? "" : ` (${label})`;
    const json = JSON.stringify(redactWsEventForLogging(event));
    this.log(`${arrow}${tag}  ${json}`);
  }

  private freshPath(): string {
    const stamp = formatFileTimestamp(new Date());
    const suffix = this.rotation > 0 ? `.${this.rotation}` : "";
    return join(this.dir, `${stamp}${suffix}.log`);
  }

  private rotate(): void {
    const previous = this.path;
    this.rotation += 1;
    this.path = this.freshPath();
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
    } catch {}
  }

  private ensureDir(): void {
    if (this.dirCreated) return;
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
      }
      this.dirCreated = true;
    } catch {}
  }
}
