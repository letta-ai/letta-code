// Codex CLI session store → normalized-v1.
//
// Store layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl — one
// JSON record per line. Parsing ported from `parse_codex_rollout` in
// extract_transcripts.py: `response_item` records are the canonical
// model-context stream; `event_msg/agent_reasoning` supplies the plaintext
// reasoning summaries (`response_item/reasoning` is encrypted); `session_meta`
// is mined for cwd / created_at / git branch, `turn_context` for cwd / model.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  PseudoRow,
  SessionContext,
} from "@/agent/trajectories/normalize-core";
import {
  blocksText,
  CODEX_INJECTED_PREFIXES,
  normalizeSessionRows,
  parseTimestamp,
} from "@/agent/trajectories/normalize-core";
import {
  buildDiscoveredSession,
  listFilesRecursive,
  matchSessionIds,
  statOrNull,
} from "@/agent/trajectories/store-utils";
import type {
  DiscoveredSession,
  NormalizedRecord,
  NormalizedSession,
  TrajectorySource,
} from "@/agent/trajectories/types";

interface CodexParseOutput {
  rows: PseudoRow[];
  extras: {
    cwd?: string;
    gitBranch?: string;
    model?: string;
    createdAt?: Date;
  };
}

/** Codex rollout JSONL → pseudo-rows plus mined session context. */
export function parseCodexRollout(text: string): CodexParseOutput {
  const rows: PseudoRow[] = [];
  const extras: CodexParseOutput["extras"] = {};
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
    const payload = (
      record.payload && typeof record.payload === "object" ? record.payload : {}
    ) as Record<string, unknown>;
    const ts = parseTimestamp(record.timestamp);
    const ptype = payload.type;

    if (rtype === "session_meta") {
      if (typeof payload.cwd === "string" && payload.cwd && !extras.cwd) {
        extras.cwd = payload.cwd;
      }
      const created = parseTimestamp(payload.timestamp) ?? ts;
      if (created && !extras.createdAt) extras.createdAt = created;
      const git = payload.git;
      if (git && typeof git === "object" && !Array.isArray(git)) {
        const branch = (git as Record<string, unknown>).branch;
        if (typeof branch === "string" && branch && !extras.gitBranch) {
          extras.gitBranch = branch;
        }
      }
      continue;
    }
    if (rtype === "turn_context") {
      if (typeof payload.cwd === "string" && payload.cwd && !extras.cwd) {
        extras.cwd = payload.cwd;
      }
      if (typeof payload.model === "string" && payload.model && !extras.model) {
        extras.model = payload.model;
      }
      continue;
    }
    if (rtype === "event_msg") {
      const reasoning = typeof payload.text === "string" ? payload.text : "";
      if (ptype === "agent_reasoning" && reasoning.trim()) {
        rows.push({
          role: "assistant",
          turnType: "assistant_thinking",
          content: reasoning,
          timestamp: ts,
        });
      }
      continue; // user_message/agent_message duplicate response items; rest is transport
    }
    if (rtype !== "response_item") continue;

    if (ptype === "message") {
      const role = payload.role;
      const body = blocksText(payload.content);
      if (role === "user") {
        const head = body.trimStart();
        if (CODEX_INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix))) {
          continue; // system-prompt-class injection
        }
        rows.push({
          role: "user",
          turnType: "user_prompt",
          content: body,
          timestamp: ts,
        });
      } else if (role === "assistant") {
        rows.push({
          role: "assistant",
          turnType: "assistant_response",
          content: body,
          timestamp: ts,
        });
      }
      // developer-role messages are the agent's instruction surface → dropped
    } else if (ptype === "function_call") {
      rows.push({
        role: "tool_use",
        turnType: "tool_use",
        timestamp: ts,
        toolName: typeof payload.name === "string" ? payload.name : undefined,
        toolCallId:
          typeof payload.call_id === "string" ? payload.call_id : undefined,
        toolInputJson:
          (typeof payload.arguments === "string" && payload.arguments) || "{}",
      });
    } else if (ptype === "custom_tool_call") {
      rows.push({
        role: "tool_use",
        turnType: "tool_use",
        timestamp: ts,
        toolName: typeof payload.name === "string" ? payload.name : undefined,
        toolCallId:
          typeof payload.call_id === "string" ? payload.call_id : undefined,
        toolInputJson: JSON.stringify({ input: payload.input ?? "" }),
      });
    } else if (ptype === "web_search_call") {
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key !== "type" && key !== "call_id" && key !== "status") {
          args[key] = value;
        }
      }
      rows.push({
        role: "tool_use",
        turnType: "tool_use",
        timestamp: ts,
        toolName: "web_search",
        toolCallId:
          typeof payload.call_id === "string" ? payload.call_id : undefined,
        toolInputJson: JSON.stringify(args),
      });
    } else if (
      ptype === "function_call_output" ||
      ptype === "custom_tool_call_output"
    ) {
      let output: unknown = payload.output;
      if (Array.isArray(output)) {
        // content-block list form
        output = blocksText(output) || JSON.stringify(output);
      } else if (output && typeof output === "object") {
        const content = (output as Record<string, unknown>).content;
        output = content || JSON.stringify(output);
      }
      if (typeof output !== "string") {
        output = output == null ? "" : String(output);
      }
      rows.push({
        role: "tool_result",
        turnType: "tool_result",
        content: (output as string) || "",
        timestamp: ts,
        toolCallId:
          typeof payload.call_id === "string" ? payload.call_id : undefined,
      });
    }
  }
  return { rows, extras };
}

function sessionIdFromPath(path: string): string {
  // rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl → YYYY-MM-DDThh-mm-ss-<uuid>
  return basename(path)
    .replace(/\.jsonl$/, "")
    .replace(/^rollout-/, "");
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
  const { rows, extras } = parseCodexRollout(text);
  const context: SessionContext = {
    source: "codex",
    cwd: extras.cwd,
    gitBranch: extras.gitBranch,
    model: extras.model,
    createdAt: extras.createdAt ?? new Date(info.mtimeMs),
  };
  const result = normalizeSessionRows(rows, context);
  const session = buildDiscoveredSession(
    "codex",
    sessionIdFromPath(path),
    path,
    info.mtimeMs,
    result,
  );
  if (!session || !result.records) return null;
  return { session, records: result.records };
}

/**
 * Trajectory source for local Codex CLI sessions. `storeDir` overrides the
 * default store (~/.codex/sessions), mainly for tests.
 */
export function createCodexSource(storeDir?: string): TrajectorySource {
  const root = storeDir ?? join(homedir(), ".codex", "sessions");
  const isRollout = (name: string) =>
    name.startsWith("rollout-") && name.endsWith(".jsonl");

  return {
    type: "codex",

    async discover(locator?: string): Promise<DiscoveredSession[]> {
      let files: string[];
      if (!locator) {
        files = listFilesRecursive(root, isRollout);
      } else {
        const info = statOrNull(locator);
        if (info?.isFile()) {
          files = [locator];
        } else if (info?.isDirectory()) {
          // Date dir or store dir — rollouts live below either.
          files = listFilesRecursive(locator, isRollout);
        } else {
          const all = listFilesRecursive(root, isRollout).map((path) => ({
            sessionId: sessionIdFromPath(path),
            path,
          }));
          const matches = matchSessionIds(locator, all);
          if (matches.length === 0) {
            throw new Error(`No Codex session matches "${locator}" in ${root}`);
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
          `Could not normalize Codex session ${session.sessionId} at ${session.path}`,
        );
      }
      return { session, records: parsed.records };
    },
  };
}
