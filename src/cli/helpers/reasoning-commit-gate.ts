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
export function isHeldSplitReasoning(lines: Line[], ln: Line): boolean {
  if (ln.kind !== "reasoning" || ln.phase !== "finished") return false;
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
