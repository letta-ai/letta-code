// Claude Code session store → normalized-v1.
//
// Store layout: ~/.claude/projects/<project-slug>/<session-uuid>.jsonl — one
// JSON record per line. Parsing ported from `parse_cc_jsonl` in
// extract_transcripts.py: one content block = one pseudo-row; sidechain
// records and transport records (incl. `progress`, which holds subagent
// transcripts) are dropped; cwd/gitBranch/model are mined for the meta record.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PseudoRow, SessionContext } from "./normalize-core";
import {
  blocksText,
  normalizeSessionRows,
  parseTimestamp,
} from "./normalize-core";
import {
  buildDiscoveredSession,
  listFilesRecursive,
  matchSessionIds,
  statOrNull,
} from "./store-utils";
import type {
  DiscoveredSession,
  NormalizedRecord,
  NormalizedSession,
  TrajectorySource,
} from "./types";

const CC_TRANSPORT_TYPES = new Set([
  "progress",
  "queue-operation",
  "file-history-snapshot",
  "summary",
  "system",
  "pr-link",
  "last-prompt",
  "custom-title",
  "ai-title",
  "agent-name",
  "permission-mode",
  "attachment",
  "mode",
]);

interface CcParseOutput {
  rows: PseudoRow[];
  extras: { cwd?: string; gitBranch?: string };
}

/** Claude Code session JSONL → pseudo-rows plus mined session context. */
export function parseClaudeCodeJsonl(text: string): CcParseOutput {
  const rows: PseudoRow[] = [];
  const extras: { cwd?: string; gitBranch?: string } = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const record = rec as Record<string, unknown>;
    const rtype = record.type;
    if (
      (typeof rtype === "string" && CC_TRANSPORT_TYPES.has(rtype)) ||
      record.isSidechain
    ) {
      continue;
    }
    if (typeof record.cwd === "string" && record.cwd && !extras.cwd) {
      extras.cwd = record.cwd;
    }
    if (
      typeof record.gitBranch === "string" &&
      record.gitBranch &&
      !extras.gitBranch
    ) {
      extras.gitBranch = record.gitBranch;
    }
    const msg = record.message;
    if (
      (rtype !== "user" && rtype !== "assistant") ||
      !msg ||
      typeof msg !== "object" ||
      Array.isArray(msg)
    ) {
      continue;
    }
    const message = msg as Record<string, unknown>;
    const ts = parseTimestamp(record.timestamp);
    const model = typeof message.model === "string" ? message.model : undefined;
    const content = message.content;
    const turnType = record.isMeta ? "system_injected" : "user_prompt";

    if (rtype === "user") {
      if (typeof content === "string") {
        rows.push({ role: "user", turnType, content, timestamp: ts });
        continue;
      }
      const textParts: string[] = [];
      for (const block of Array.isArray(content) ? content : []) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          rows.push({
            role: "tool_result",
            turnType: "tool_result",
            content: blocksText(b.content),
            timestamp: ts,
            toolCallId:
              typeof b.tool_use_id === "string" ? b.tool_use_id : undefined,
          });
        } else if (b.type === "text") {
          textParts.push(typeof b.text === "string" ? b.text : "");
        } else if (b.type === "image") {
          textParts.push("[image]");
        }
      }
      if (textParts.length > 0) {
        rows.push({
          role: "user",
          turnType,
          content: textParts.join("\n"),
          timestamp: ts,
        });
      }
    } else {
      // assistant
      for (const block of Array.isArray(content) ? content : []) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "thinking") {
          rows.push({
            role: "assistant",
            turnType: "assistant_thinking",
            content: typeof b.thinking === "string" ? b.thinking : "",
            timestamp: ts,
            model,
          });
        } else if (b.type === "text") {
          rows.push({
            role: "assistant",
            turnType: "assistant_response",
            content: typeof b.text === "string" ? b.text : "",
            timestamp: ts,
            model,
          });
        } else if (b.type === "tool_use") {
          rows.push({
            role: "tool_use",
            turnType: "tool_use",
            timestamp: ts,
            model,
            toolName: typeof b.name === "string" ? b.name : undefined,
            toolCallId: typeof b.id === "string" ? b.id : undefined,
            toolInputJson: JSON.stringify(b.input ?? {}),
          });
        }
      }
      if (typeof content === "string" && content.trim()) {
        rows.push({
          role: "assistant",
          turnType: "assistant_response",
          content,
          timestamp: ts,
          model,
        });
      }
    }
  }
  return { rows, extras };
}

function sessionIdFromPath(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

interface ParsedSessionFile {
  session: DiscoveredSession;
  records: NormalizedRecord[];
}

function parseSessionFile(path: string): ParsedSessionFile | null {
  const info = statOrNull(path);
  if (!info?.isFile()) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { rows, extras } = parseClaudeCodeJsonl(text);
  const context: SessionContext = {
    source: "claude_code",
    ...extras,
    createdAt: new Date(info.mtimeMs),
  };
  const result = normalizeSessionRows(rows, context);
  const session = buildDiscoveredSession(
    "claude",
    sessionIdFromPath(path),
    path,
    info.mtimeMs,
    result,
  );
  if (!session || !result.records) return null;
  return { session, records: result.records };
}

/**
 * Trajectory source for local Claude Code sessions. `storeDir` overrides the
 * default store (~/.claude/projects), mainly for tests.
 */
export function createClaudeCodeSource(storeDir?: string): TrajectorySource {
  const root = storeDir ?? join(homedir(), ".claude", "projects");
  const isSessionFile = (name: string) => name.endsWith(".jsonl");

  return {
    type: "claude",

    async discover(locator?: string): Promise<DiscoveredSession[]> {
      let files: string[];
      if (!locator) {
        files = listFilesRecursive(root, isSessionFile);
      } else {
        const info = statOrNull(locator);
        if (info?.isFile()) {
          files = [locator];
        } else if (info?.isDirectory()) {
          // Project dir or store dir — both hold .jsonl sessions below them.
          files = listFilesRecursive(locator, isSessionFile);
        } else {
          const all = listFilesRecursive(root, isSessionFile).map((path) => ({
            sessionId: sessionIdFromPath(path),
            path,
          }));
          const matches = matchSessionIds(locator, all);
          if (matches.length === 0) {
            throw new Error(
              `No Claude Code session matches "${locator}" in ${root}`,
            );
          }
          files = matches.map((m) => m.path);
        }
      }
      const sessions: DiscoveredSession[] = [];
      for (const file of files) {
        const parsed = parseSessionFile(file);
        if (parsed) sessions.push(parsed.session);
      }
      sessions.sort((a, b) => a.mtimeMs - b.mtimeMs);
      return sessions;
    },

    async normalize(session: DiscoveredSession): Promise<NormalizedSession> {
      const parsed = parseSessionFile(session.path);
      if (!parsed) {
        throw new Error(
          `Could not normalize Claude Code session ${session.sessionId} at ${session.path}`,
        );
      }
      return { session, records: parsed.records };
    },
  };
}
