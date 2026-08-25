/**
 * Commit gates for transcript lines moving from the live area into
 * <Static>. Extracted from AppCoordinator so the commit loop stays lean;
 * each predicate answers one question about one line.
 */

import type { Line } from "./accumulator";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
} from "./tool-name-mapping";

/**
 * Should this finished line be held back in the live area?
 *
 * A split reasoning header carries phase "finished" by construction, but
 * its thought may still be streaming. Static prints a child exactly once
 * and never repaints it, so committing such a header would freeze its
 * elapsed timer forever; it stays live until the whole block is done.
 */
export function shouldHoldSplitReasoning(
  ln: Line,
  byId: Map<string, Line>,
): boolean {
  if (ln.kind !== "reasoning" || ln.phase !== "finished") return false;
  // Every part of a still-streaming block waits for the block to finish:
  // committing tails immediately would print them above the header,
  // which only lands in Static once the block is done.
  const blockId = ln.id.split("-split-")[0];
  if (!blockId || blockId === ln.id) return false;
  const original = byId.get(blockId);
  return original?.kind === "reasoning" && original.phase === "streaming";
}

/**
 * Is this a finished split header whose thought block is still streaming?
 * Used by the live-area filter: such headers must stay visible there,
 * because they are held out of Static while the block streams.
 */
/**
 * Trailing text budget (terminal lines) shown in the live area while an
 * expanded thought streams. Keeping the live zone short prevents Ink's
 * full-screen clearTerminal repaints once output exceeds the terminal
 * height; the full text lands in Static when the block finishes.
 */
export const REASONING_STREAM_WINDOW_LINES = 18;

/**
 * Which reasoning line ids belong in the live area right now?
 *
 * Only parts of still-streaming blocks are ever held. Collapsed: just the
 * ticking header. Expanded: the header plus a trailing window of text so
 * the thought grows on screen without flooding the live area.
 */
export function getVisibleStreamingParts(
  lines: Line[],
  expanded: boolean,
): Set<string> {
  type ReasoningLineT = Extract<Line, { kind: "reasoning" }>;
  const visible = new Set<string>();
  const originals = new Map<string, ReasoningLineT>();
  for (const ln of lines) {
    if (ln.kind === "reasoning" && !ln.id.includes("-split-")) {
      originals.set(ln.id, ln);
    }
  }
  const blocks = new Map<string, ReasoningLineT[]>();
  for (const ln of lines) {
    if (ln.kind !== "reasoning" || !ln.id.includes("-split-")) continue;
    const blockId = ln.id.split("-split-")[0];
    if (!blockId) continue;
    const original = originals.get(blockId);
    if (!original || original.phase !== "streaming") continue;
    let parts = blocks.get(blockId);
    if (!parts) {
      parts = [];
      blocks.set(blockId, parts);
    }
    parts.push(ln);
  }
  for (const [blockId, parts] of blocks) {
    const original = originals.get(blockId);
    if (!original) continue;
    const header = parts.find((p) => !p.isContinuation);
    if (!expanded) {
      if (header) visible.add(header.id);
      continue;
    }
    if (header) visible.add(header.id);
    let budget = REASONING_STREAM_WINDOW_LINES;
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!part || part === header || budget <= 0) break;
      visible.add(part.id);
      budget -= Math.max(1, part.text.split("\n").length);
    }
    visible.add(original.id);
  }
  return visible;
}

/**
 * True when this reasoning line must NOT render in the live area right
 * now: collapsed mode hides continuation halves entirely (they would only
 * contribute an empty margin box per split).
 */
export function isHiddenReasoningTail(
  ln: { kind: string; isContinuation?: boolean },
  expanded: boolean,
): boolean {
  return ln.kind === "reasoning" && !!ln.isContinuation && !expanded;
}

/**
 * Is this a part of a still-streaming block that belongs in the live area?
 *
 * Collapsed: only the header (tails would render as empty boxes with
 * margins, one blank line per split). Expanded: every part, so the thought
 * grows on screen as it streams. Finished blocks are never held — they go
 * to Static in transcript order when the block completes.
 */
export function isHeldSplitReasoning(
  lines: Line[],
  ln: Line,
  expanded: boolean,
): boolean {
  if (ln.kind !== "reasoning" || ln.phase !== "finished") return false;
  if (!expanded && ln.isContinuation) return false;
  const blockId = ln.id.split("-split-")[0];
  if (!blockId || blockId === ln.id) return false;
  const original = lines.find((candidate) => candidate.id === blockId);
  return original?.kind === "reasoning" && original.phase === "streaming";
}

/**
 * Skip re-committing a finished file tool_call whose tall preview was
 * already committed eagerly: the preview already represents the result.
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

/**
 * Skip deferral when the tool result is already available: the component
 * height has already changed (header + result), so deferring only extends
 * the live-area repaint window that causes ghost lines in scrollback.
 */
export function shouldSkipDeferral(ln: Line): boolean {
  if (ln.kind !== "tool_call") return false;
  if (ln.phase !== "finished") return false;
  return ln.resultText != null;
}
