// Shared types for the trajectory normalization pipeline ("normalized-v1").
//
// A normalized transcript is a JSON array whose optional leading record is
// `{role: "meta", source, cwd?, git_branch?, model?}` followed by
// user / reasoning / assistant / tool records, each with an ISO timestamp.
// Assistant records are either prose (content, no tool_calls) or tool
// invocations (content null, tool_calls with stringified JSON args). Tool
// results link back via tool_call_id.
//
// This record shape must stay compatible with the batch-reflection prototype.

export interface NormalizedRecord {
  role: "meta" | "user" | "reasoning" | "assistant" | "tool";
  content?: string | null;
  timestamp?: string;
  source?: string;
  tool_calls?: { id: string; name: string; args: string }[];
  tool_call_id?: string;
  cwd?: string;
  git_branch?: string;
  model?: string;
}

export interface DiscoveredSession {
  harness: string; // "claude" | "codex" | "openhands" | "transcript"
  sessionId: string;
  path: string; // session file or directory on disk
  startTime: string; // ISO timestamp of first conversation record
  endTime: string; // ISO timestamp of last conversation record
  estTokens: number; // ~chars/4 of raw content
  recordCount: number;
  mtimeMs: number;
  cwd?: string; // working directory the session ran in, when known
}

export interface NormalizedSession {
  session: DiscoveredSession;
  records: NormalizedRecord[]; // leading meta record when metadata known
}

export interface TrajectorySource {
  /** The scheme used in `--from <type>[:<locator>]`. */
  type: string;
  /**
   * Discover candidate sessions. With no locator, scan the harness's default
   * local store. With a locator, resolve it as a path (session file, session
   * dir, project dir, or store dir) or a session-id prefix and return the
   * matching session(s) — cursor filtering happens in the caller, so discover
   * should return ALL sessions in the store when the locator names a store or
   * is absent, and the single named session when it names one.
   */
  discover(locator?: string): Promise<DiscoveredSession[]>;
  /** Fully parse + normalize one discovered session. */
  normalize(session: DiscoveredSession): Promise<NormalizedSession>;
}

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const NORMALIZED_ROLES = new Set([
  "meta",
  "user",
  "reasoning",
  "assistant",
  "tool",
]);

export function isNormalizedRecordArray(
  value: unknown,
): value is NormalizedRecord[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.role !== "string" || !NORMALIZED_ROLES.has(rec.role)) {
      return false;
    }
    if (
      rec.content !== undefined &&
      rec.content !== null &&
      typeof rec.content !== "string"
    ) {
      return false;
    }
    if (rec.timestamp !== undefined && typeof rec.timestamp !== "string") {
      return false;
    }
    if (rec.tool_calls !== undefined) {
      if (!Array.isArray(rec.tool_calls)) return false;
      for (const call of rec.tool_calls) {
        if (call === null || typeof call !== "object") return false;
        const c = call as Record<string, unknown>;
        if (
          typeof c.id !== "string" ||
          typeof c.name !== "string" ||
          typeof c.args !== "string"
        ) {
          return false;
        }
      }
    }
    return true;
  });
}
