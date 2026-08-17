// Shared assembly for the normalized-v1 transcript format: pseudo-rows (one
// per content block, produced by the per-harness parsers) are normalized into
// v1 records with noise filtering, tool-call linking, truncation, timestamp
// interpolation/synthesis, and structural validation.
//
// This is a faithful TypeScript port of `extract_transcripts.py` (itself
// ported from `envs/memory_synth_gen/swe_chat/normalize.py` in
// letta-ai/letta-train).

import type { NormalizedRecord } from "./types";

// Caps from the letta-train normalizer: args pass through essentially whole
// (pathological-payload guard); results are the bulky, truncatable part.
export const TOOL_INPUT_MAX_CHARS = 20_000;
export const TOOL_RESULT_MAX_CHARS = 2_500;
const ARGS_LEAF_FLOOR = 2_000;

// Harness-noise classes: slash-command echoes and background-task pings are
// dropped; all other harness-injected context is kept verbatim.
const INJECTED_NOISE_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<task-notification",
];

// Codex system-prompt-class blocks injected as user-role response items —
// dropped like the agent's own system prompt, not kept as user context.
export const CODEX_INJECTED_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<permissions instructions>",
  "<turn_context>",
];

const SYNTH_BASE_MS = Date.UTC(2026, 0, 1);
const SYNTH_STEP_SECONDS = 15;

const TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function truncationMarker(n: number): string {
  return `\n… [truncated, ${n} more chars]`;
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + truncationMarker(text.length - limit);
}

function iso(date: Date): string {
  return date.toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ, matching _iso()
}

/**
 * Timestamp from the raw formats: ISO string or epoch millis. Suffix-less
 * (naive) timestamps are treated as UTC so ordering is stable.
 */
export function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "number" && value > 1e11) {
    return new Date(value); // epoch millis
  }
  if (typeof value === "string" && value) {
    const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
    const date = new Date(withZone);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * ISO timestamps for n records: real where present, interpolated in gaps,
 * synthesized monotonically when the source recorded none.
 */
export function fillTimestamps(
  n: number,
  anchors: Map<number, Date>,
  createdAt: Date | null,
  durationSeconds: number | null,
): string[] {
  if (n === 0) return [];
  if (anchors.size === 0) {
    const baseMs = (createdAt ?? new Date(SYNTH_BASE_MS)).getTime();
    let step = SYNTH_STEP_SECONDS;
    if (durationSeconds && n > 1) step = durationSeconds / (n - 1);
    return Array.from({ length: n }, (_, i) =>
      iso(new Date(baseMs + step * 1000 * i)),
    );
  }

  const out: string[] = new Array(n).fill("");
  const idxs = [...anchors.keys()].sort((a, b) => a - b);
  const first = idxs[0] ?? 0;
  const last = idxs[idxs.length - 1] ?? 0;
  const anchorMs = (i: number): number => anchors.get(i)?.getTime() ?? 0;

  for (let i = 0; i < first; i++) {
    out[i] = iso(new Date(anchorMs(first) - (first - i) * 1000));
  }
  for (let k = 0; k + 1 < idxs.length; k++) {
    const a = idxs[k] ?? 0;
    const b = idxs[k + 1] ?? 0;
    out[a] = iso(new Date(anchorMs(a)));
    const spanMs = anchorMs(b) - anchorMs(a);
    const gap = b - a;
    for (let i = a + 1; i < b; i++) {
      out[i] = iso(new Date(anchorMs(a) + (spanMs * (i - a)) / gap));
    }
  }
  out[last] = iso(new Date(anchorMs(last)));
  for (let i = last + 1; i < n; i++) {
    out[i] = iso(new Date(anchorMs(last) + (i - last) * 1000));
  }
  return out;
}

type LeafParent = Record<string, unknown> | unknown[];

/**
 * Return the args string (and whether it was reshaped). Byte-verbatim when
 * under the cap and already a JSON object; otherwise reshaped to a valid JSON
 * object, trimming the longest string values until the serialization fits.
 */
export function shrinkArgs(rawInput: string): {
  args: string;
  shrunk: boolean;
} {
  const raw = rawInput || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      args: JSON.stringify({ _raw: truncateText(raw, TOOL_INPUT_MAX_CHARS) }),
      shrunk: true,
    };
  }
  if (raw.length <= TOOL_INPUT_MAX_CHARS) return { args: raw, shrunk: false };

  const leaves: { node: LeafParent; key: string | number }[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const val = node[i];
        if (typeof val === "string") leaves.push({ node, key: i });
        else if (val && typeof val === "object") collect(val);
      }
    } else if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === "string") leaves.push({ node: obj, key });
        else if (val && typeof val === "object") collect(val);
      }
    }
  };
  collect(parsed);

  const leafValue = (leaf: {
    node: LeafParent;
    key: string | number;
  }): string =>
    (leaf.node as Record<string | number, unknown>)[leaf.key] as string;

  let dumped = JSON.stringify(parsed);
  while (dumped.length > TOOL_INPUT_MAX_CHARS && leaves.length > 0) {
    let best = leaves[0];
    if (!best) break;
    for (const leaf of leaves) {
      if (leafValue(leaf).length > leafValue(best).length) best = leaf;
    }
    const val = leafValue(best);
    if (val.length <= ARGS_LEAF_FLOOR) break;
    const keep = Math.max(ARGS_LEAF_FLOOR, Math.floor(val.length / 2));
    (best.node as Record<string | number, unknown>)[best.key] =
      val.slice(0, keep) + truncationMarker(val.length - keep);
    dumped = JSON.stringify(parsed);
  }
  return { args: dumped, shrunk: true };
}

/**
 * Flatten a content field (string | block list) into text; image blocks
 * render as a placeholder.
 */
export function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const b = block as { type?: string | null; text?: string | null };
    if (
      b.type === "text" ||
      b.type === "input_text" ||
      b.type === "output_text" ||
      (b.type == null && "text" in b)
    ) {
      out.push(b.text ?? "");
    } else if (b.type === "image") {
      out.push("[image]");
    }
  }
  return out.filter((x) => x).join("\n");
}

/** One raw content block, as emitted by a per-harness parser. */
export interface PseudoRow {
  role: "user" | "assistant" | "tool_use" | "tool_result";
  turnType:
    | "user_prompt"
    | "system_injected"
    | "assistant_thinking"
    | "assistant_response"
    | "tool_use"
    | "tool_result";
  content?: string;
  timestamp?: Date | null;
  /** Stable id from the raw source record, when available. */
  sourceId?: string;
  toolName?: string;
  toolCallId?: string;
  toolInputJson?: string;
  model?: string;
}

/** Session-level context mined from the raw store during parsing. */
export interface SessionContext {
  source: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  createdAt?: Date | null;
  durationSeconds?: number | null;
}

export type NormalizeRowsResult =
  | { status: "ok"; records: NormalizedRecord[] }
  | { status: string; records?: undefined };

/**
 * Normalize ordered pseudo-rows into v1 records. Returns `{status: "ok",
 * records}` or a `skipped:…` / `invalid:…` status with no output records.
 */
export function normalizeSessionRows(
  rows: PseudoRow[],
  context: SessionContext,
): NormalizeRowsResult {
  const body: NormalizedRecord[] = [];
  const anchors = new Map<number, Date>();
  const openCalls = new Map<string, { finalId: string; consumed: boolean }[]>();
  const usedIds = new Set<string>();
  const models = new Map<string, number>();
  let n = 0; // running row index for synthetic call ids

  for (const row of rows) {
    n += 1;
    if (row.model) models.set(row.model, (models.get(row.model) ?? 0) + 1);
    const content = row.content ?? "";
    let record: NormalizedRecord;

    if (
      row.role === "user" &&
      (row.turnType === "user_prompt" || row.turnType === "system_injected")
    ) {
      const head = content.trimStart();
      if (!head) continue; // blank row
      if (INJECTED_NOISE_PREFIXES.some((prefix) => head.startsWith(prefix))) {
        continue; // harness noise
      }
      record = { role: "user", content };
    } else if (
      row.role === "assistant" &&
      row.turnType === "assistant_thinking"
    ) {
      if (!content.trim()) continue;
      record = { role: "reasoning", content };
    } else if (row.role === "assistant") {
      if (!content.trim()) continue;
      record = { role: "assistant", content };
    } else if (row.role === "tool_use") {
      const sourceId = row.toolCallId || `call_${n}`;
      let finalId = sourceId;
      if (usedIds.has(finalId)) {
        let k = 2;
        while (usedIds.has(`${sourceId}__${k}`)) k += 1;
        finalId = `${sourceId}__${k}`;
      }
      usedIds.add(finalId);
      const entries = openCalls.get(sourceId) ?? [];
      entries.push({ finalId, consumed: false });
      openCalls.set(sourceId, entries);
      const { args } = shrinkArgs(row.toolInputJson || "{}");
      record = {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: finalId, name: row.toolName || "unknown_tool", args },
        ],
      };
    } else if (row.role === "tool_result") {
      const entries = openCalls.get(row.toolCallId || "");
      const entry = entries?.find((e) => !e.consumed);
      if (!entry) continue; // orphan or duplicate result
      entry.consumed = true;
      record = {
        role: "tool",
        tool_call_id: entry.finalId,
        content: truncateText(content, TOOL_RESULT_MAX_CHARS),
      };
    } else {
      continue; // metadata rows: transport, not conversation
    }

    if (row.sourceId) record.source_id = row.sourceId;

    const ts = row.timestamp;
    if (ts instanceof Date && !Number.isNaN(ts.getTime())) {
      anchors.set(body.length, ts);
    }
    body.push(record);
  }

  const rolesPresent = new Set(body.map((r) => r.role));
  for (const required of ["user", "assistant"] as const) {
    if (!rolesPresent.has(required)) {
      return { status: `skipped:no_${required}_records` };
    }
  }

  const meta: NormalizedRecord = { role: "meta", source: context.source };
  if (context.cwd) meta.cwd = context.cwd;
  if (context.gitBranch) meta.git_branch = context.gitBranch;
  let model = context.model;
  if (!model && models.size > 0) {
    // Most common model; ties break by first-seen (stable sort).
    const ranked = [...models.entries()].sort((a, b) => b[1] - a[1]);
    model = ranked[0]?.[0];
  }
  if (model) meta.model = model;

  const stamps = fillTimestamps(
    body.length,
    anchors,
    context.createdAt ?? null,
    context.durationSeconds ?? null,
  );
  for (let i = 0; i < body.length; i++) {
    const record = body[i];
    if (record) record.timestamp = stamps[i];
  }
  const records = [meta, ...body];

  const problem = validateRecords(records);
  if (problem) return { status: `invalid:${problem}` };
  return { status: "ok", records };
}

/**
 * Minimal structural validation of the normalized-v1 contract. Returns an
 * error string, or null when valid.
 */
export function validateRecords(records: NormalizedRecord[]): string | null {
  if (records.length === 0) return "empty transcript";
  const openIds = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) return `record ${i}: missing`;
    const role = rec.role;
    if (role === "meta") {
      if (i !== 0) return `record ${i}: meta must be leading`;
      if (!rec.source) return "meta: missing source";
      continue;
    }
    const ts = rec.timestamp;
    if (typeof ts !== "string" || !TS_RE.test(ts)) {
      return `record ${i}: bad timestamp ${JSON.stringify(ts)}`;
    }
    if (role === "user" || role === "reasoning") {
      if (typeof rec.content !== "string") {
        return `record ${i}: ${role} content must be a string`;
      }
    } else if (role === "assistant") {
      const calls = rec.tool_calls;
      if (calls !== undefined) {
        if (rec.content !== null && rec.content !== undefined) {
          return `record ${i}: assistant with tool_calls must have null content`;
        }
        if (calls.length === 0) return `record ${i}: empty tool_calls`;
        for (const call of calls) {
          if (!call.id || !call.name) {
            return `record ${i}: tool_call missing id/name`;
          }
          if (typeof call.args !== "string") {
            return `record ${i}: tool_call args must be a string`;
          }
          try {
            JSON.parse(call.args);
          } catch {
            return `record ${i}: tool_call args not valid JSON`;
          }
          openIds.add(call.id);
        }
      } else if (!(typeof rec.content === "string" && rec.content)) {
        return `record ${i}: prose assistant must have non-empty content`;
      }
    } else if (role === "tool") {
      if (!rec.tool_call_id || !openIds.has(rec.tool_call_id)) {
        return `record ${i}: tool result with unknown tool_call_id`;
      }
      if (typeof rec.content !== "string") {
        return `record ${i}: tool content must be a string`;
      }
    } else {
      return `record ${i}: unknown role ${JSON.stringify(role)}`;
    }
  }
  return null;
}
