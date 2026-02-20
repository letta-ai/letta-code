/**
 * ChunkLog - Rolling log of the last N streaming chunks received by the client.
 *
 * Stores truncated chunks as JSONL on disk (~/.letta/chunk-log.jsonl).
 * Metadata (message_type, ids, timestamps) is preserved fully;
 * large content fields (reasoning, tool_return, arguments, etc.) are
 * truncated to keep the file compact.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";

const MAX_ENTRIES = 100;
const CONTENT_TRUNCATE_LEN = 200;
const LOG_PATH = join(homedir(), ".letta", "chunk-log.jsonl");

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
  private buffer: string[] = [];

  constructor() {
    // Load existing entries from disk on startup
    this.loadFromDisk();
  }

  /**
   * Append a chunk to the log. Truncates content, writes to disk.
   */
  append(chunk: LettaStreamingResponse): void {
    const entry = truncateChunk(chunk);
    const line = JSON.stringify(entry);
    this.buffer.push(line);

    // Trim to max entries
    if (this.buffer.length > MAX_ENTRIES) {
      this.buffer = this.buffer.slice(-MAX_ENTRIES);
    }

    this.writeToDisk();
  }

  /**
   * Get all entries as a JSON array string (for sending in feedback payload).
   */
  getEntries(): string {
    return `[${this.buffer.join(",")}]`;
  }

  /**
   * Clear the log (e.g. on session start).
   */
  clear(): void {
    this.buffer = [];
    this.writeToDisk();
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

  private loadFromDisk(): void {
    try {
      if (existsSync(LOG_PATH)) {
        const content = readFileSync(LOG_PATH, "utf8").trim();
        if (content) {
          this.buffer = content.split("\n").slice(-MAX_ENTRIES);
        }
      }
    } catch {
      // Silently ignore read errors -- start fresh
      this.buffer = [];
    }
  }

  private writeToDisk(): void {
    try {
      const dir = dirname(LOG_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(LOG_PATH, `${this.buffer.join("\n")}\n`, "utf8");
    } catch {
      // Silently ignore write errors -- in-memory log still works
    }
  }
}

// Singleton instance
export const chunkLog = new ChunkLog();
