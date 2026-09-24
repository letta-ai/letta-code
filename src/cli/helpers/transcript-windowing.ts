// src/cli/helpers/transcript-windowing.ts
// Bounded-window retention for committed transcript state (LET-13142).
//
// Ink's <Static> tracks rendered items by absolute array index, so committed
// entries can never be removed from the items array without a full remount and
// terminal repaint. Memory is instead bounded on two axes:
//
// 1. The accumulator (Buffers.byId/order and its id maps) drops each line once
//    it is committed to static. The static copy becomes the only full record.
// 2. Committed static items older than a trailing window get their heavy
//    payload fields (tool results, args, reasoning/assistant text, command
//    output) truncated. Static never re-renders old items, so trimming only
//    becomes visible on a full repaint (thinking/reminder toggles, ctrl+o),
//    where old entries render with a trimmed marker.
//
// Post-commit updates to a line were already invisible before this change
// (the static copy is frozen at commit time), so dropping the committed line
// from the buffers preserves display semantics: those updates were and remain
// no-ops for rendering.

import type { Buffers, Line } from "./accumulator";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
} from "./tool-name-mapping";

/** Number of trailing committed static items kept at full fidelity. */
export const STATIC_FULL_FIDELITY_WINDOW = 100;

/** FIFO caps for secondary id/alias maps that previously grew unbounded. */
const EMITTED_IDS_CAP = 8192;
const ALIAS_MAP_CAP = 4096;
const USER_LINE_OTID_CAP = 1024;
const SPLIT_COUNTER_CAP = 2048;
const SERVER_TOOL_CALL_CAP = 1024;
const UNIFIED_EXEC_SESSION_CAP = 512;

/** Per-field payload caps (characters) applied when trimming old items. */
const CAP_REASONING_TEXT = 8_000;
const CAP_ASSISTANT_TEXT = 16_000;
const CAP_USER_TEXT = 16_000;
const CAP_TOOL_RESULT = 4_000;
const CAP_TOOL_ARGS = 2_000;
const CAP_COMMAND_INPUT = 2_000;
const CAP_COMMAND_OUTPUT = 4_000;
const CAP_ERROR_TEXT = 4_000;
const CAP_EVENT_SUMMARY = 4_000;
const CAP_EVENT_DATA_JSON = 2_000;
const CAP_STATUS_LINES_TOTAL = 4_000;

/** Objects already processed by the trimming pass (items are stable across
 * array spreads, so identity tracking survives setStaticItems updates). */
const trimmedItems = new WeakSet<object>();

function capText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… [${text.length - cap} chars trimmed]`;
}

function capOptionalText(
  text: string | undefined,
  cap: number,
): string | undefined {
  return text === undefined ? undefined : capText(text, cap);
}

/** Return a copy of the line with heavy payload fields truncated, or the
 * original line when there is nothing to trim. */
function trimLinePayload(line: Line): Line {
  switch (line.kind) {
    case "reasoning":
    case "assistant":
      return {
        ...line,
        text: capText(
          line.text,
          line.kind === "reasoning" ? CAP_REASONING_TEXT : CAP_ASSISTANT_TEXT,
        ),
      };
    case "user":
      return { ...line, text: capText(line.text, CAP_USER_TEXT) };
    case "tool_call":
      return {
        ...line,
        argsText: capOptionalText(line.argsText, CAP_TOOL_ARGS),
        resultText: capOptionalText(line.resultText, CAP_TOOL_RESULT),
        streaming: undefined,
      };
    case "error":
      return { ...line, text: capText(line.text, CAP_ERROR_TEXT) };
    case "command":
      return {
        ...line,
        input: capText(line.input, CAP_COMMAND_INPUT),
        output: capText(line.output, CAP_COMMAND_OUTPUT),
      };
    case "bash_command":
      return {
        ...line,
        input: capText(line.input, CAP_COMMAND_INPUT),
        output: capText(line.output, CAP_COMMAND_OUTPUT),
        streaming: undefined,
      };
    case "event": {
      let eventData = line.eventData;
      try {
        if ((JSON.stringify(eventData)?.length ?? 0) > CAP_EVENT_DATA_JSON) {
          eventData = {};
        }
      } catch {
        eventData = {};
      }
      return {
        ...line,
        eventData,
        summary: capOptionalText(line.summary, CAP_EVENT_SUMMARY),
      };
    }
    case "status": {
      const total = line.lines.reduce((acc, l) => acc + l.length, 0);
      if (total <= CAP_STATUS_LINES_TOTAL) return line;
      const kept: string[] = [];
      let used = 0;
      for (const l of line.lines) {
        if (used + l.length > CAP_STATUS_LINES_TOTAL) break;
        kept.push(l);
        used += l.length;
      }
      kept.push(`… [${total - used} chars trimmed]`);
      return { ...line, lines: kept };
    }
    default:
      // separator, trajectory_summary: no heavy payload.
      return line;
  }
}

/** Trim one committed static item. Non-Line kinds (welcome, subagent_group)
 * pass through; approval_preview drops its cached diff and caps tool args. */
function trimStaticItem<T extends { kind: string; id: string }>(item: T): T {
  if (item.kind === "approval_preview") {
    const preview = item as T & {
      toolArgs: string;
      precomputedDiff?: unknown;
    };
    return {
      ...preview,
      toolArgs: capText(preview.toolArgs, CAP_TOOL_ARGS),
      precomputedDiff: undefined,
    } as T;
  }
  if (item.kind === "welcome" || item.kind === "subagent_group") return item;
  return trimLinePayload(item as unknown as Line) as unknown as T;
}

/**
 * Combine newly committed items into the static list and trim heavy payloads
 * for items that fall outside the trailing full-fidelity window.
 *
 * `renderedCount` is the number of items Ink's <Static> has already rendered
 * (tracked via a passive effect that runs after Static's layout effect). Only
 * items below that frontier are eligible for trimming, so an item is always
 * rendered at full fidelity at least once before its payload is truncated.
 */
export function commitStaticItems<T extends { kind: string; id: string }>(
  prev: T[],
  newlyCommitted: T[],
  renderedCount: number | { readonly current: number },
  window: number = STATIC_FULL_FIDELITY_WINDOW,
): T[] {
  const rendered =
    typeof renderedCount === "number" ? renderedCount : renderedCount.current;
  const combined = [...prev, ...newlyCommitted];
  const trimEnd = Math.min(rendered, combined.length) - window;
  for (let i = 0; i < trimEnd; i++) {
    const item = combined[i];
    if (!item || trimmedItems.has(item)) continue;
    const trimmed = trimStaticItem(item);
    trimmedItems.add(trimmed);
    combined[i] = trimmed;
  }
  return combined;
}

function capMap<K, V>(map: Map<K, V>, cap: number): void {
  let toDelete = map.size - cap;
  for (const key of map.keys()) {
    if (toDelete <= 0) break;
    map.delete(key);
    toDelete--;
  }
}

function capSet<T>(set: Set<T>, cap: number): void {
  let toDelete = set.size - cap;
  for (const value of set) {
    if (toDelete <= 0) break;
    set.delete(value);
    toDelete--;
  }
}

/**
 * Drop committed lines from the accumulator's live buffers. A line is
 * evictable once its id is in `emittedIds` — meaning it was either pushed to
 * the static area or deliberately skipped, and its display state is final.
 * Lines re-created later with an already-committed id (e.g. replayed chunks
 * from a resumed stream) are caught by the same membership check and evicted
 * without being re-committed.
 *
 * `emittedIds` entries are retained (FIFO-capped) rather than deleted: the
 * live-area filter and late-chunk coalescing rely on recently committed ids
 * staying marked until the next refresh.
 */
export function evictCommittedLines(
  b: Buffers,
  emittedIds: Set<string>,
  eagerCommittedPreviews?: Set<string>,
): void {
  let evictedAny = false;
  for (const id of b.order) {
    if (!emittedIds.has(id)) continue;
    const line = b.byId.get(id);
    if (!line) continue;
    if (line.kind === "tool_call" && line.toolCallId) {
      b.toolCallIdToLineId.delete(line.toolCallId);
      b.serverToolCalls.delete(line.toolCallId);
      eagerCommittedPreviews?.delete(line.toolCallId);
    }
    if (line.kind === "user" && line.otid) {
      b.userLineIdByOtid.delete(line.otid);
    }
    b.byId.delete(id);
    evictedAny = true;
  }
  if (evictedAny) {
    b.order = b.order.filter((id) => b.byId.has(id));
  }
  capMap(b.assistantCanonicalByMessageId, ALIAS_MAP_CAP);
  capMap(b.assistantCanonicalByOtid, ALIAS_MAP_CAP);
  capMap(b.reasoningCanonicalByMessageId, ALIAS_MAP_CAP);
  capMap(b.reasoningCanonicalByOtid, ALIAS_MAP_CAP);
  capMap(b.toolCallIdToLineId, ALIAS_MAP_CAP);
  capMap(b.userLineIdByOtid, USER_LINE_OTID_CAP);
  capMap(b.splitCounters, SPLIT_COUNTER_CAP);
  capMap(b.serverToolCalls, SERVER_TOOL_CALL_CAP);
  capMap(b.unifiedExecSessionCommands, UNIFIED_EXEC_SESSION_CAP);
  capSet(emittedIds, EMITTED_IDS_CAP);
}

/** Mirrors commitEligibleLines eligibility: which backfilled lines are in
 * their final state and can move to static. Unfinished lines (e.g. a pending
 * approval request at the history tail) must stay live so their result can
 * still attach and commit later. */
function isFinalBackfilledLine(line: Line): boolean {
  if (!("phase" in line)) return true;
  return line.phase === undefined || line.phase === "finished";
}

/**
 * Drain backfilled history lines into static items and reset the per-line
 * buffer state. Used by resume/conversation-switch paths that bulk-commit
 * history; without the reset, every backfilled line would stay resident in
 * the accumulator for the rest of the session. Unfinished lines (pending
 * approvals, in-flight tool calls) stay in the buffers with their id
 * mappings, matching the startup resume path: their results attach on
 * arrival and commit through commitEligibleLines.
 */
export function drainBackfilledItems<T extends { kind: string; id: string }>(
  b: Buffers,
  emittedIds: Set<string>,
): T[] {
  const items: T[] = [];
  const retained: string[] = [];
  for (const id of b.order) {
    const line = b.byId.get(id);
    if (!line) continue;
    if (!isFinalBackfilledLine(line)) {
      retained.push(id);
      continue;
    }
    emittedIds.add(id);
    items.push({ ...line } as T);
    b.byId.delete(id);
  }
  b.order = retained;
  // Rebuild per-line maps so only retained (unfinished) lines keep entries.
  b.toolCallIdToLineId.clear();
  for (const id of retained) {
    const line = b.byId.get(id);
    if (line?.kind === "tool_call" && line.toolCallId) {
      b.toolCallIdToLineId.set(line.toolCallId, id);
    }
  }
  b.userLineIdByOtid.clear();
  b.assistantCanonicalByMessageId.clear();
  b.assistantCanonicalByOtid.clear();
  b.reasoningCanonicalByMessageId.clear();
  b.reasoningCanonicalByOtid.clear();
  b.splitCounters.clear();
  b.serverToolCalls.clear();
  b.unifiedExecSessionCommands.clear();
  return items;
}

/**
 * Extracted commit-policy predicates (kept next to the windowing logic they
 * interact with). See commitEligibleLines in AppCoordinator for usage.
 */
export function shouldSkipCommittedToolCall(
  ln: Line,
  eagerCommittedPreviews: Set<string>,
): boolean {
  if (ln.kind !== "tool_call") return false;
  if (!ln.toolCallId || !ln.name) return false;
  if (ln.phase !== "finished" || ln.resultOk === false) return false;
  if (!eagerCommittedPreviews.has(ln.toolCallId)) return false;
  return (
    isFileEditTool(ln.name) || isFileWriteTool(ln.name) || isPatchTool(ln.name)
  );
}

export function shouldSkipDeferral(ln: Line): boolean {
  if (ln.kind !== "tool_call") return false;
  if (ln.phase !== "finished") return false;
  // Skip deferral when the result is already available: the component height
  // has already changed (header + result), so deferring only extends the
  // live-area repaint window that causes ghost lines in the terminal scrollback.
  return ln.resultText != null;
}
