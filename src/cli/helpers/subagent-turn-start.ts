import type { Buffers } from "./accumulator.js";

export function shouldClearCompletedSubagentsOnTurnStart(
  allowReentry: boolean,
  hasActiveSubagents: boolean,
): boolean {
  return !allowReentry && !hasActiveSubagents;
}

export function flushEligibleLinesBeforeReentry(
  commitEligibleLines: (
    b: Buffers,
    opts?: { deferToolCalls?: boolean },
  ) => void,
  buffers: Buffers,
): void {
  commitEligibleLines(buffers, { deferToolCalls: false });
}
