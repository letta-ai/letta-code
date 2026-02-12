import { describe, expect, test } from "bun:test";
import {
  createContextTracker,
  resetContextHistory,
} from "../../cli/helpers/contextTracker";

describe("contextTracker", () => {
  test("resetContextHistory clears token history and pending compaction flags", () => {
    const tracker = createContextTracker();
    tracker.lastContextTokens = 123;
    tracker.contextTokensHistory = [
      { timestamp: 1, tokens: 111, turnId: 1, compacted: true },
    ];
    tracker.pendingCompaction = true;
    tracker.pendingSkillsReinject = true;
    tracker.pendingReflectionTrigger = true;
    tracker.currentTurnId = 9;

    resetContextHistory(tracker);

    expect(tracker.lastContextTokens).toBe(0);
    expect(tracker.contextTokensHistory).toEqual([]);
    expect(tracker.pendingCompaction).toBe(false);
    expect(tracker.pendingSkillsReinject).toBe(false);
    expect(tracker.pendingReflectionTrigger).toBe(false);
    expect(tracker.currentTurnId).toBe(9);
  });
});
