import type { Buffers } from "./accumulator.js";

/**
 * Completed subagents should only be cleared on true new turns.
 * During allowReentry (post-approval continuation), completed subagents
 * must remain available so deferred Task grouping can still resolve.
 */
export function shouldClearCompletedSubagentsOnTurnStart(
  allowReentry: boolean,
  hasActiveSubagents: boolean,
): boolean {
  return !allowReentry && !hasActiveSubagents;
}

/**
 * Flush static-eligible lines before reentry so Task grouping is not delayed
 * by deferred non-Task tool commits.
 */
export function flushEligibleLinesBeforeReentry(
  commitEligibleLines: (
    b: Buffers,
    opts?: { deferToolCalls?: boolean },
  ) => void,
  buffers: Buffers,
): void {
  commitEligibleLines(buffers, { deferToolCalls: false });
}
