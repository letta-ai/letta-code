import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedRecord } from "@letta-ai/trajectory";
import type {
  SessionManifestEntry,
  TrajectoryManifest,
} from "@/cli/subcommands/trajectories/types";

/**
 * Read-side helpers for a trajectory export directory: list the manifest,
 * render one session readably, and search message content. These back the
 * `letta trajectories list|view|search` commands and are source-agnostic —
 * every session is trajectory-v1, whatever harness produced it.
 */

export interface SessionFilter {
  source?: string;
  project?: string;
}

export async function readManifest(dir: string): Promise<TrajectoryManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, "manifest.json"), "utf-8");
  } catch {
    throw new Error(
      `No manifest at ${join(dir, "manifest.json")}. Run: letta trajectories export --out ${dir}`,
    );
  }
  return JSON.parse(raw) as TrajectoryManifest;
}

export function filterSessions(
  sessions: SessionManifestEntry[],
  filter: SessionFilter,
): SessionManifestEntry[] {
  return sessions.filter(
    (session) =>
      (!filter.source || session.source === filter.source) &&
      (!filter.project || (session.project ?? "").startsWith(filter.project)),
  );
}

/**
 * Resolve a `view` target to a trajectory file path: an explicit path to a
 * `.json` file, or a manifest lookup by `sessionId` / relative `file`.
 */
export async function resolveSessionFile(
  dir: string,
  target: string,
): Promise<string> {
  if (target.endsWith(".json")) {
    const direct = target.includes("/") ? target : join(dir, target);
    try {
      await readFile(direct, "utf-8");
      return direct;
    } catch {
      // Fall through to manifest lookup (e.g. a manifest-relative file path).
    }
  }
  const manifest = await readManifest(dir);
  const entry = manifest.sessions.find(
    (session) => session.sessionId === target || session.file === target,
  );
  if (!entry) {
    throw new Error(
      `No session "${target}" in ${dir} (pass a file path, a manifest-relative file, or a sessionId)`,
    );
  }
  return join(dir, entry.file);
}

export interface RenderOptions {
  tools?: boolean;
  reasoning?: boolean;
}

const TOOL_RESULT_MAX_CHARS = 500;
const REASONING_MAX_CHARS = 300;
const TOOL_ARGS_MAX_CHARS = 150;

function stamp(timestamp: string | undefined): string {
  return (timestamp ?? "").slice(0, 19);
}

/** Render one normalized session as a readable conversation transcript. */
export function renderSession(
  records: NormalizedRecord[],
  options: RenderOptions = {},
): string {
  const lines: string[] = [];
  for (const record of records) {
    if (record.role === "meta") {
      lines.push(`=== ${record.source} session ===`);
      lines.push(
        `Project: ${record.cwd ?? "?"}   Model: ${record.model ?? "?"}   Branch: ${record.git_branch ?? "?"}`,
        "",
      );
    } else if (record.role === "user") {
      lines.push(`>>> USER [${stamp(record.timestamp)}]:`, record.content, "");
    } else if (record.role === "assistant") {
      if ("tool_calls" in record) {
        if (options.tools) {
          const calls = record.tool_calls
            .map(
              (call) =>
                `${call.name}(${call.args.slice(0, TOOL_ARGS_MAX_CHARS)})`,
            )
            .join("; ");
          lines.push(
            `<<< TOOL CALLS [${stamp(record.timestamp)}]: ${calls}`,
            "",
          );
        }
      } else {
        lines.push(
          `<<< ASSISTANT [${stamp(record.timestamp)}]:`,
          record.content ?? "",
          "",
        );
      }
    } else if (record.role === "tool") {
      if (options.tools) {
        lines.push(
          `>>> TOOL RESULT [${stamp(record.timestamp)}]:`,
          record.content.slice(0, TOOL_RESULT_MAX_CHARS),
          "",
        );
      }
    } else if (record.role === "reasoning") {
      if (options.reasoning) {
        lines.push(
          `<<< REASONING [${stamp(record.timestamp)}]:`,
          record.content.slice(0, REASONING_MAX_CHARS),
          "",
        );
      }
    }
  }
  return lines.join("\n");
}

export interface SearchOptions extends SessionFilter {
  role?: "user" | "assistant";
  /** Max matches reported per session (default 5). */
  perSession?: number;
}

export interface SessionMatch {
  timestamp?: string;
  role: string;
  text: string;
}

export interface SearchResult {
  session: SessionManifestEntry;
  matches: SessionMatch[];
}

const MATCH_SNIPPET_MAX_CHARS = 160;
const DEFAULT_MATCHES_PER_SESSION = 5;

/**
 * Case-insensitive substring search over user/assistant prose across every
 * session in the export (subject to source/project/role filters).
 */
export async function searchSessions(
  dir: string,
  keyword: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const manifest = await readManifest(dir);
  const needle = keyword.toLowerCase();
  const perSession = options.perSession ?? DEFAULT_MATCHES_PER_SESSION;
  const results: SearchResult[] = [];
  for (const session of filterSessions(manifest.sessions, options)) {
    let records: NormalizedRecord[];
    try {
      records = JSON.parse(await readFile(join(dir, session.file), "utf-8"));
    } catch {
      continue;
    }
    const matches: SessionMatch[] = [];
    for (const record of records) {
      if (matches.length >= perSession) break;
      if (record.role !== "user" && record.role !== "assistant") continue;
      if (options.role && record.role !== options.role) continue;
      const content = "content" in record ? record.content : null;
      if (!content || !content.toLowerCase().includes(needle)) continue;
      matches.push({
        timestamp: record.timestamp,
        role: record.role,
        text: content.replace(/\s+/g, " ").slice(0, MATCH_SNIPPET_MAX_CHARS),
      });
    }
    if (matches.length > 0) {
      results.push({ session, matches });
    }
  }
  return results;
}
