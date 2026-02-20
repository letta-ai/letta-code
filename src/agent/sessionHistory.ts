import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionStatsSnapshot } from "./stats";

export interface SessionHistoryEntry {
  agent_id: string;
  session_id: string;
  timestamp: number;
  project: string;
  model: string;
  provider: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_input_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    context_tokens?: number;
    steps: number;
  };
  duration: {
    api_ms: number;
    wall_ms: number;
  };
  cost: {
    type: "hosted" | "byok";
    credits_used?: number;
    usd_byok?: number;
  };
  message_count?: number;
  tool_call_count?: number;
  exit_reason?: string;
}

interface SessionStartData {
  agentId: string;
  sessionId: string;
  project: string;
  model: string;
  provider: string;
}

/**
 * Get the Letta Code history directory
 */
function getHistoryDir(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".letta-code");
}

/**
 * Get the session history file path
 */
function getHistoryFilePath(): string {
  return path.join(getHistoryDir(), "sessions.jsonl");
}

/**
 * Ensure the history directory and file exist
 */
function ensureHistoryFile(): void {
  const dir = getHistoryDir();
  const filePath = getHistoryFilePath();

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "");
  }
}

/**
 * Record session start data (called when a session begins)
 */
export function recordSessionStart(data: SessionStartData): void {
  ensureHistoryFile();

  const entry: SessionHistoryEntry = {
    agent_id: data.agentId,
    session_id: data.sessionId,
    timestamp: Date.now(),
    project: data.project,
    model: data.model,
    provider: data.provider,
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      steps: 0,
    },
    duration: {
      api_ms: 0,
      wall_ms: 0,
    },
    cost: {
      type: "hosted", // Default, will be updated on session end
    },
  };

  const filePath = getHistoryFilePath();
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

/**
 * Update session entry with final stats (called when session ends)
 * For now, this just updates an in-memory tracking - actual file updates
 * would require rewriting the file or using a different storage approach
 */
export function recordSessionEnd(
  agentId: string,
  sessionId: string,
  stats: SessionStatsSnapshot,
  sessionInfo?: { project?: string; model?: string; provider?: string },
  cost?: { credits_used?: number; usd_byok?: number; type: "hosted" | "byok" },
  metadata?: {
    messageCount?: number;
    toolCallCount?: number;
    exitReason?: string;
  },
): void {
  // For now, we'll append a new "end" entry with the final stats
  // A more sophisticated approach would update the existing entry
  const entry: SessionHistoryEntry = {
    agent_id: agentId,
    session_id: sessionId,
    timestamp: Date.now(),
    project: sessionInfo?.project ?? "",
    model: sessionInfo?.model ?? "",
    provider: sessionInfo?.provider ?? "",
    usage: {
      prompt_tokens: stats.usage.promptTokens,
      completion_tokens: stats.usage.completionTokens,
      total_tokens: stats.usage.totalTokens,
      cached_input_tokens: stats.usage.cachedInputTokens,
      cache_write_tokens: stats.usage.cacheWriteTokens,
      reasoning_tokens: stats.usage.reasoningTokens,
      context_tokens: stats.usage.contextTokens,
      steps: stats.usage.stepCount,
    },
    duration: {
      api_ms: stats.totalApiMs,
      wall_ms: stats.totalWallMs,
    },
    cost: cost || { type: "hosted" },
    message_count: metadata?.messageCount,
    tool_call_count: metadata?.toolCallCount,
    exit_reason: metadata?.exitReason,
  };

  // For v1, we just append end entries - in future, we could update the start entry
  const filePath = getHistoryFilePath();
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

/**
 * Read all session history entries
 */
export function getSessionHistory(): SessionHistoryEntry[] {
  const filePath = getHistoryFilePath();

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  return lines.map((line) => JSON.parse(line) as SessionHistoryEntry);
}
