/**
 * Turn-boundary eviction for the live transcript buffers (LET-13142).
 *
 * The Ink `<Static>` transcript renders immutable copies of committed lines,
 * so the accumulator buffers only need lines that can still change (streaming
 * text, running tools, pending approvals). Historically every line was
 * retained in the buffers until /clear or a conversation switch. The helpers
 * here evict committed lines at turn boundaries and bound the secondary maps,
 * keeping buffer memory proportional to the in-flight turn.
 *
 * Why turn boundaries: the reflection transcript delta slices
 * `toLines(buffers)` by an index captured at submit time, so buffer order
 * must stay stable between submit and end of turn. Eviction therefore runs
 * at new-turn entry (via `prepareBuffersForTurn`), never mid-turn.
 *
 * Why the id/otid alias maps are size-trimmed rather than pruned per line:
 * late chunks of a mixed id/otid stream resolve through them, and the
 * resolvers use prior aliases to open a fresh line when a message emits
 * another content block after an earlier block finished.
 */

import type { Buffers } from "./accumulator";
import { normalizeConversationTitle } from "./conversation-title";
import { isShellOutputTool } from "./tool-name-mapping";

// Alias entries stitch chunks of a single message stream; entries older than
// this many ids are never read again.
export const MAX_LINE_ALIAS_ENTRIES = 10_000;

// exec_command sessions remembered for write_stdin "background terminal"
// labels. Sessions older than this lose their label but keep working.
export const MAX_UNIFIED_EXEC_SESSION_COMMANDS = 500;

/** Drop oldest-inserted entries until the map fits within maxEntries. */
function trimMapToMaxSize<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * Evict lines that have been committed to the static transcript from the
 * live buffers, prune per-line mappings that only exist to mutate a line
 * while it is live, and size-trim the unbounded secondary maps.
 *
 * Per-line pruning:
 * - toolCallIdToLineId / serverToolCalls for tool_call lines: a late
 *   tool_return for an evicted line now misses the mapping and is dropped by
 *   the accumulator's existing `if (!id) continue` path instead of
 *   re-creating an invisible zombie line. (serverToolCalls is already deleted
 *   on the normal tool_return path; this also covers cancelled tools, whose
 *   entries otherwise lingered for the rest of the session.)
 * - userLineIdByOtid for user lines: a late echo for an evicted line falls
 *   into the accumulator's existing "unmapped echo" drop path.
 * - splitCounters for split streaming lines (only read while a line streams).
 *
 * A line whose id is committed is removed even if it was re-created after a
 * previous eviction (e.g. a tool_call_message re-sent on stream resume): such
 * zombies are invisible to the live render path (the id is still in the
 * committed set) and are re-evicted here.
 *
 * Returns the number of lines evicted.
 */
export function evictCommittedLines(
  buffers: Buffers,
  committedIds: ReadonlySet<string>,
): number {
  let evicted = 0;
  if (committedIds.size > 0 && buffers.order.length > 0) {
    const kept: string[] = [];
    for (const id of buffers.order) {
      if (!committedIds.has(id)) {
        kept.push(id);
        continue;
      }
      const line = buffers.byId.get(id);
      if (!line) continue; // dangling committed id; drop from order
      if (line.kind === "tool_call" && line.toolCallId) {
        if (buffers.toolCallIdToLineId.get(line.toolCallId) === id) {
          buffers.toolCallIdToLineId.delete(line.toolCallId);
        }
        buffers.serverToolCalls.delete(line.toolCallId);
      }
      if (line.kind === "user" && line.otid) {
        if (buffers.userLineIdByOtid.get(line.otid) === id) {
          buffers.userLineIdByOtid.delete(line.otid);
        }
      }
      buffers.splitCounters.delete(id);
      buffers.byId.delete(id);
      evicted++;
    }
    if (kept.length !== buffers.order.length) {
      buffers.order = kept;
    }
  }
  trimMapToMaxSize(
    buffers.assistantCanonicalByMessageId,
    MAX_LINE_ALIAS_ENTRIES,
  );
  trimMapToMaxSize(buffers.assistantCanonicalByOtid, MAX_LINE_ALIAS_ENTRIES);
  trimMapToMaxSize(
    buffers.reasoningCanonicalByMessageId,
    MAX_LINE_ALIAS_ENTRIES,
  );
  trimMapToMaxSize(buffers.reasoningCanonicalByOtid, MAX_LINE_ALIAS_ENTRIES);
  trimMapToMaxSize(
    buffers.unifiedExecSessionCommands,
    MAX_UNIFIED_EXEC_SESSION_COMMANDS,
  );
  return evicted;
}

/**
 * Reset per-turn buffer state and evict committed lines at a turn boundary.
 * Must run before the optimistic user line is appended and before the turn's
 * transcript start index is captured: the reflection transcript delta slices
 * live lines by that index at end of turn, so the buffer window must stay
 * stable for the rest of the turn.
 */
export function prepareBuffersForTurn(
  buffers: Buffers,
  committedIds: ReadonlySet<string>,
): void {
  evictCommittedLines(buffers, committedIds);
  buffers.tokenCount = 0;
  buffers.interrupted = false;
}

/**
 * Structural view of a committed or live line for shell tool detection.
 * Satisfied by both accumulator lines and static transcript items.
 */
interface ShellToolCallProbe {
  id: string;
  kind: string;
  phase?: string;
  resultText?: string;
  name?: string;
}

function isFinishedShellToolCall(line: ShellToolCallProbe): boolean {
  return (
    line.kind === "tool_call" &&
    line.phase === "finished" &&
    !!line.resultText &&
    !!line.name &&
    isShellOutputTool(line.name)
  );
}

/**
 * Find the most recent finished shell tool call, which ctrl+o expands.
 * Live (uncommitted) lines are scanned first because they are always newer
 * than committed shell tool calls: a deferred commit blocks all later lines
 * from committing, so a finished-but-uncommitted shell tool call is never
 * followed in the transcript by an already-committed one.
 */
export function findLastShellToolCallId(
  buffers: Buffers,
  committedItems: readonly ShellToolCallProbe[],
): string | null {
  for (let i = buffers.order.length - 1; i >= 0; i--) {
    const id = buffers.order[i];
    if (!id) continue;
    const line = buffers.byId.get(id);
    if (line && isFinishedShellToolCall(line)) return id;
  }
  for (let i = committedItems.length - 1; i >= 0; i--) {
    const item = committedItems[i];
    if (item && isFinishedShellToolCall(item)) return item.id;
  }
  return null;
}

/**
 * First user line with a usable conversation title, scanning live buffers.
 * Post-eviction this only covers uncommitted lines; callers should prefer a
 * title captured at commit time and use this as a final fallback.
 */
export function findFirstUserLineTitle(buffers: Buffers): string | null {
  for (const lineId of buffers.order) {
    const line = buffers.byId.get(lineId);
    if (!line || line.kind !== "user") continue;
    const title = normalizeConversationTitle(line.text);
    if (title) return title;
  }
  return null;
}
