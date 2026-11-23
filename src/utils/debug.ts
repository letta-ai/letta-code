import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

export function isDebugEnabled(): boolean {
  const lettaDebug = process.env.LETTA_DEBUG;
  const legacyDebug = process.env.DEBUG;
  return (
    lettaDebug === "1" ||
    lettaDebug === "true" ||
    legacyDebug === "1" ||
    legacyDebug === "true"
  );
}

function getDebugFile(): string | null {
  const path = process.env.LETTA_DEBUG_FILE;
  return path && path.trim().length > 0 ? path : null;
}

function printDebugLine(line: string, level: "log" | "warn" = "log"): void {
  const debugFile = getDebugFile();
  if (debugFile) {
    try {
      appendFileSync(debugFile, line, { encoding: "utf8" });
      return;
    } catch {}
  }
  const colored =
    level === "warn"
      ? `\x1b[38;5;167m${line.trimEnd()}\x1b[0m`
      : `\x1b[38;5;179m${line.trimEnd()}\x1b[0m`;
  console.error(colored);
}

const DEBUG_LOG_DIR = join(resolveGlobalConfigDir(), "logs", "debug");
const MAX_SESSION_FILES = 5;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const DEFAULT_TAIL_LINES = 50;

interface DebugLogFileOptions {
  dir?: string;
  maxBytes?: number;
}

class DebugLogFile {
  private logPath: string | null = null;
  private agentDir: string | null = null;
  private dirCreated = false;
  private bytesWritten = 0;
  private maxBytes = MAX_LOG_BYTES;
  private truncationNoted = false;

  init(
    agentId: string,
    sessionId: string,
    options: DebugLogFileOptions = {},
  ): void {
    const telem = process.env.LETTA_CODE_TELEM;
    if (telem === "0" || telem === "false") return;

    this.agentDir = join(options.dir ?? DEBUG_LOG_DIR, agentId);
    this.logPath = join(this.agentDir, `${sessionId}.log`);
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.dirCreated = false;
    this.bytesWritten = 0;
    this.truncationNoted = false;
    this.pruneOldSessions();
  }

  appendLine(line: string): void {
    if (!this.logPath) return;
    if (this.bytesWritten >= this.maxBytes) {
      if (!this.truncationNoted) {
        this.truncationNoted = true;
        this.writeRaw(
          `${new Date().toISOString()} [debug] log truncated after ${this.maxBytes} bytes\n`,
        );
      }
      return;
    }
    this.writeRaw(line);
  }

  private writeRaw(line: string): void {
    if (!this.logPath) return;
    this.ensureDir();
    try {
      appendFileSync(this.logPath, line, { encoding: "utf8" });
      this.bytesWritten += Buffer.byteLength(line, "utf8");
    } catch {}
  }

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
    } catch {}
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
          } catch {}
        }
      }
    } catch {}
  }
}

export const debugLogFile = new DebugLogFile();

function writeDebugLine(
  prefix: string,
  message: string,
  args: unknown[],
  level: "log" | "warn" = "log",
): void {
  const ts = new Date().toISOString();
  const body = format(`[${prefix}] ${message}`, ...args);
  const line = `${ts} ${body}\n`;

  debugLogFile.appendLine(line);

  if (isDebugEnabled()) {
    printDebugLine(line, level);
  }
}

export function debugLog(
  prefix: string,
  message: string,
  ...args: unknown[]
): void {
  writeDebugLine(prefix, message, args);
}

export function debugWarn(
  prefix: string,
  message: string,
  ...args: unknown[]
): void {
  writeDebugLine(prefix, `WARN: ${message}`, args, "warn");
}
