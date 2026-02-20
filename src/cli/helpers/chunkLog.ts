/**
 * ChunkLog - Rolling log of the last N streaming chunks received by the client.
 *
 * Stores truncated chunks as JSONL on disk, organized per agent per session:
 *   ~/.letta/logs/chunk-logs/{agent_id}/{session_id}.jsonl
 *
 * Metadata (message_type, ids, timestamps) is preserved fully;
 * large content fields (reasoning, tool_return, arguments, etc.) are
 * truncated to keep the file compact.
 *
 * Old session logs are garbage-collected: only the most recent N sessions
 * per agent are kept on disk.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { debugWarn } from "../../utils/debug";

const MAX_ENTRIES = 100;
const CONTENT_TRUNCATE_LEN = 200;
const MAX_SESSION_FILES = 5;
const LOG_BASE_DIR = join(homedir(), ".letta", "logs", "chunk-logs");

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

function truncateStr(value: unknown, maxLen: number): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...[truncated, was ${s.length}b]`;
}

/**
 * Build a compact representation of a chunk, preserving all metadata but
 * truncating large content fields.
 */
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
      // Truncate arguments inside tool_call / tool_calls
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

    // Small/important chunk types -- keep as-is
    case "ping":
    case "error_message":
    case "stop_reason":
    case "usage_statistics":
      return raw;

    // Unknown types -- shallow copy, truncate any "content" field
    default: {
      const result = { ...raw };
      if (typeof result.content === "string" || Array.isArray(result.content)) {
        result.content = truncateStr(result.content, CONTENT_TRUNCATE_LEN);
      }
      return result;
    }
  }
}

// ---------------------------------------------------------------------------
// ChunkLog class
// ---------------------------------------------------------------------------

class ChunkLog {
  private buffer: Record<string, unknown>[] = [];
  private dirty = false;
  private logPath: string | null = null;
  private agentDir: string | null = null;
  private dirCreated = false;

  /**
   * Initialize the chunk log for a specific agent + session.
   * Must be called before append/flush will write to disk.
   * Clears in-memory buffer and garbage-collects old session files.
   */
  init(agentId: string, sessionId: string): void {
    this.agentDir = join(LOG_BASE_DIR, agentId);
    this.logPath = join(this.agentDir, `${sessionId}.jsonl`);
    this.buffer = [];
    this.dirty = false;
    this.dirCreated = false;

    // GC old session files for this agent (keep last N)
    this.pruneOldSessions();
  }

  /**
   * Append a chunk to the in-memory log. Does NOT write to disk.
   * Call flush() after a stream completes to persist.
   */
  append(chunk: LettaStreamingResponse): void {
    this.buffer.push(truncateChunk(chunk));

    // Drop oldest entry if over capacity
    if (this.buffer.length > MAX_ENTRIES) {
      this.buffer.shift();
    }

    this.dirty = true;
  }

  /**
   * Flush buffered entries to disk. Call once per stream drain, not per chunk.
   */
  flush(): void {
    if (this.dirty && this.logPath) {
      this.writeToDisk();
      this.dirty = false;
    }
  }

  /**
   * Get all entries as an array of objects (for sending in feedback payload).
   */
  getEntries(): Record<string, unknown>[] {
    return this.buffer;
  }

  /**
   * Number of entries currently in the log.
   */
  get size(): number {
    return this.buffer.length;
  }

  // -----------------------------------------------------------------------
  // Disk I/O
  // -----------------------------------------------------------------------

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

  /**
   * Remove old session log files, keeping only the most recent N.
   *
   * Session filenames start with Date.now() (e.g. "1740000000000-abc123.jsonl"),
   * so lexicographic sort orders them chronologically.
   */
  private pruneOldSessions(): void {
    if (!this.agentDir) return;
    try {
      if (!existsSync(this.agentDir)) return;
      const files = readdirSync(this.agentDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();

      // Keep the newest MAX_SESSION_FILES (excluding the current one
      // which may not exist on disk yet)
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

// Singleton instance
export const chunkLog = new ChunkLog();
