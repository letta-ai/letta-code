import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { debugWarn } from "@/utils/debug";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

const MAX_ENTRIES = 100;
const CONTENT_TRUNCATE_LEN = 200;
const MAX_SESSION_FILES = 5;
const LOG_BASE_DIR = join(resolveGlobalConfigDir(), "logs", "chunk-logs");

function truncateStr(value: unknown, maxLen: number): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...[truncated, was ${s.length}b]`;
}

function truncateChunk(chunk: LettaStreamingResponse): Record<string, unknown> {
  const raw = chunk as Record<string, unknown>;
  const type = raw.message_type as string | undefined;

  switch (type) {
    case "reasoning_message":
      return {
        ...raw,
        reasoning: truncateStr(raw.reasoning, CONTENT_TRUNCATE_LEN),
      };

    case "assistant_message":
      return {
        ...raw,
        content: truncateStr(raw.content, CONTENT_TRUNCATE_LEN),
      };

    case "tool_call_message": {
      const truncateToolCall = (tc: Record<string, unknown>) => ({
        ...tc,
        arguments: truncateStr(tc.arguments, CONTENT_TRUNCATE_LEN),
      });

      const result: Record<string, unknown> = { ...raw };

      if (raw.tool_call && typeof raw.tool_call === "object") {
        result.tool_call = truncateToolCall(
          raw.tool_call as Record<string, unknown>,
        );
      }
      if (Array.isArray(raw.tool_calls)) {
        result.tool_calls = (raw.tool_calls as Record<string, unknown>[]).map(
          truncateToolCall,
        );
      }
      return result;
    }

    case "tool_return_message":
      return {
        ...raw,
        tool_return: truncateStr(raw.tool_return, CONTENT_TRUNCATE_LEN),
      };

    case "ping":
    case "error_message":
    case "stop_reason":
    case "usage_statistics":
      return raw;

    default: {
      const result = { ...raw };
      if (typeof result.content === "string" || Array.isArray(result.content)) {
        result.content = truncateStr(result.content, CONTENT_TRUNCATE_LEN);
      }
      return result;
    }
  }
}

class ChunkLog {
  private buffer: Record<string, unknown>[] = [];
  private dirty = false;
  private logPath: string | null = null;
  private agentDir: string | null = null;
  private dirCreated = false;

  init(agentId: string, sessionId: string): void {
    this.agentDir = join(LOG_BASE_DIR, agentId);
    this.logPath = join(this.agentDir, `${sessionId}.jsonl`);
    this.buffer = [];
    this.dirty = false;
    this.dirCreated = false;

    this.pruneOldSessions();
  }

  append(chunk: LettaStreamingResponse): void {
    this.buffer.push(truncateChunk(chunk));

    if (this.buffer.length > MAX_ENTRIES) {
      this.buffer.shift();
    }

    this.dirty = true;
  }

  flush(): void {
    if (this.dirty && this.logPath) {
      this.writeToDisk();
      this.dirty = false;
    }
  }

  getEntries(): Record<string, unknown>[] {
    return this.buffer;
  }

  get size(): number {
    return this.buffer.length;
  }

  private ensureDir(): void {
    if (this.dirCreated || !this.agentDir) return;
    try {
      if (!existsSync(this.agentDir)) {
        mkdirSync(this.agentDir, { recursive: true });
      }
      this.dirCreated = true;
    } catch (e) {
      debugWarn(
        "chunkLog",
        `Failed to create directory ${this.agentDir}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private writeToDisk(): void {
    if (!this.logPath) return;
    this.ensureDir();
    try {
      const content = this.buffer
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      writeFileSync(this.logPath, `${content}\n`, "utf8");
    } catch (e) {
      debugWarn(
        "chunkLog",
        `Failed to write ${this.logPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private pruneOldSessions(): void {
    if (!this.agentDir) return;
    try {
      if (!existsSync(this.agentDir)) return;
      const files = readdirSync(this.agentDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();

      if (files.length >= MAX_SESSION_FILES) {
        const toDelete = files.slice(0, files.length - MAX_SESSION_FILES + 1);
        for (const file of toDelete) {
          try {
            unlinkSync(join(this.agentDir, file));
          } catch (e) {
            debugWarn(
              "chunkLog",
              `Failed to delete old session log ${file}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    } catch (e) {
      debugWarn(
        "chunkLog",
        `Failed to prune old sessions: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

export const chunkLog = new ChunkLog();
