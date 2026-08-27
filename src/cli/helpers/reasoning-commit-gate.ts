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
 * Trailing text budget (estimated terminal lines) for the live area while
 * an expanded thought streams, shared by ALL parts of the block. Keeping
 * the live zone short prevents Ink's full-screen clearTerminal repaints
 * once output exceeds the terminal height; the full text lands in Static
 * when the block finishes.
 */
export const REASONING_STREAM_WINDOW_LINES = 16;

/**
 * Estimated terminal height of a piece of reasoning text at the given
 * content width: raw newlines plus wraps of long lines. A cheap upper
 * bound — good enough to keep the live zone well under the screen.
 */
function estimateHeight(text: string, contentWidth: number): number {
  const cols = Math.max(20, contentWidth);
  let height = 0;
  for (const rawLine of text.split("\n")) {
    height += Math.max(1, Math.ceil(rawLine.length / cols));
  }
  return Math.max(1, height);
}

/**
 * Which reasoning line ids belong in the live area right now?
 *
 * Only parts of still-streaming blocks are ever held. Collapsed: just the
 * ticking header. Expanded: as many trailing split parts as fit in
 * REASONING_STREAM_WINDOW_LINES (wrap-aware estimate, shared budget for
 * the whole block), so the thought grows on screen without flooding the
 * live area. Each rendered part also self-caps its lines (see
 * ReasoningMessage) so a single oversized part cannot overflow alone.
 */
export function getVisibleStreamingParts(
  lines: Line[],
  expanded: boolean,
  contentWidth: number,
): Set<string> {
  type ReasoningLineT = Extract<Line, { kind: "reasoning" }>;
  const visible = new Set<string>();
  const originals = new Map<string, ReasoningLineT>();
  for (const ln of lines) {
    if (ln.kind === "reasoning" && !ln.id.includes("-split-")) {
      originals.set(ln.id, ln);
    }
  }
  for (const ln of lines) {
    if (ln.kind !== "reasoning") continue;
    if (!ln.id.includes("-split-")) {
      // The original itself only needs holding while it streams (it does
      // anyway via the generic streaming rule); splits are what vanish.
      continue;
    }
    const blockId = ln.id.split("-split-")[0];
    if (!blockId) continue;
    const original = originals.get(blockId);
    if (!original || original.phase !== "streaming") continue;
    if (!expanded && ln.isContinuation) continue;
    visible.add(ln.id);
  }
  if (!expanded) return visible;
  // Budget the trailing parts per streaming block, newest first.
  let budget = REASONING_STREAM_WINDOW_LINES;
  for (let i = lines.length - 1; i >= 0 && budget > 0; i--) {
    const ln = lines[i];
    if (
      !ln ||
      ln.kind !== "reasoning" ||
      !ln.id.includes("-split-") ||
      visible.has(ln.id)
    ) {
      continue;
    }
    const blockId = ln.id.split("-split-")[0];
    const original = blockId ? originals.get(blockId) : undefined;
    if (!original || original.phase !== "streaming") continue;
    const height = estimateHeight(ln.text, contentWidth);
    if (height > budget) break;
    budget -= height;
    visible.add(ln.id);
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
