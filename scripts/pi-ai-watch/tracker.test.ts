import { describe, expect, test } from "bun:test";
import type { PiAiWatchAnalysis } from "./release-analysis.ts";
import {
  advanceMergedPr,
  getPendingPrForCursor,
  hasCompletedRange,
  hasRecordedOutcome,
  initialTrackerState,
  parseTrackerState,
  recordAnalysis,
  renderTrackerBody,
} from "./tracker.ts";

describe("pi-ai watch tracker", () => {
  test("round trips the initial installed-version cursor", () => {
    const state = initialTrackerState("0.82.1");
    expect(parseTrackerState(renderTrackerBody(state))).toEqual(state);
  });

  test("advances after a no-upgrade decision", () => {
    const state = recordAnalysis(initialTrackerState("0.82.1"), {
      analysis: analysis("0.82.1", "0.83.0"),
      outcome: "no_upgrade",
      notes: "upstream-only provider change",
      processedAt: "2026-08-21T00:00:00Z",
    });
    expect(state.audit_cursor_version).toBe("0.83.0");
    expect(hasCompletedRange(state, "0.82.1", "0.83.0")).toBe(true);
    expect(hasRecordedOutcome(state, "0.82.1", "0.83.0")).toBe(true);
  });

  test("keeps a created PR pending until it merges", () => {
    const pending = recordAnalysis(initialTrackerState("0.82.1"), {
      analysis: analysis("0.82.1", "0.83.0"),
      outcome: "pr_created",
      notes: "upgrade",
      prUrl: "https://github.com/letta-ai/letta-code/pull/123",
      processedAt: "2026-08-21T00:00:00Z",
    });
    expect(pending.audit_cursor_version).toBe("0.82.1");
    expect(getPendingPrForCursor(pending)?.version).toBe("0.83.0");
    expect(hasCompletedRange(pending, "0.82.1", "0.83.0")).toBe(false);
    expect(hasRecordedOutcome(pending, "0.82.1", "0.83.0")).toBe(true);

    const merged = advanceMergedPr(pending, "0.83.0");
    expect(merged.audit_cursor_version).toBe("0.83.0");
    expect(getPendingPrForCursor(merged)).toBeNull();
  });

  test("keeps errors retryable and replaces them with a later outcome", () => {
    const failed = recordAnalysis(initialTrackerState("0.82.1"), {
      analysis: analysis("0.82.1", "0.83.0"),
      outcome: "error",
      notes: "agent failed",
      processedAt: "2026-08-21T00:00:00Z",
    });
    expect(failed.audit_cursor_version).toBe("0.82.1");
    expect(hasRecordedOutcome(failed, "0.82.1", "0.83.0")).toBe(false);

    const retried = recordAnalysis(failed, {
      analysis: analysis("0.82.1", "0.83.0"),
      outcome: "no_upgrade",
      notes: "reviewed on retry",
      processedAt: "2026-08-21T01:00:00Z",
    });
    expect(retried.audit_cursor_version).toBe("0.83.0");
    expect(retried.processed).toHaveLength(1);
    expect(retried.processed[0]?.outcome).toBe("no_upgrade");
  });

  test("advances uncertain releases but not explicit non-adjacent replays", () => {
    const human = recordAnalysis(initialTrackerState("0.82.1"), {
      analysis: analysis("0.82.1", "0.83.0"),
      outcome: "needs_human_review",
      notes: "product decision",
    });
    expect(human.audit_cursor_version).toBe("0.83.0");

    const replay = recordAnalysis(initialTrackerState("0.82.1"), {
      analysis: analysis("0.82.1", "0.84.0", false),
      outcome: "no_upgrade",
      notes: "explicit replay",
    });
    expect(replay.audit_cursor_version).toBe("0.82.1");
  });

  test("rejects malformed hidden state", () => {
    expect(() => parseTrackerState("missing")).toThrow(
      "pi-ai tracker hidden state is missing",
    );
    expect(() =>
      parseTrackerState(`<!-- pi-ai-watch-state
{"audit_cursor_version":"latest","last_checked_version":null,"last_checked_at":null,"processed":[]}
-->`),
    ).toThrow("pi-ai tracker hidden state is invalid");
  });

  test("bounds tracker history", () => {
    let state = initialTrackerState("0.1.0");
    for (let index = 1; index <= 60; index += 1) {
      const previous = `0.${index}.0`;
      const current = `0.${index}.1`;
      state = recordAnalysis(state, {
        analysis: analysis(previous, current, false),
        outcome: "error",
        notes: `attempt ${index}`,
        processedAt: `2026-08-21T00:${String(index).padStart(2, "0")}:00Z`,
      });
    }
    expect(state.processed).toHaveLength(50);
    expect(state.processed[0]?.version).toBe("0.60.1");
  });
});

function analysis(
  previousVersion: string,
  currentVersion: string,
  adjacent = true,
): PiAiWatchAnalysis {
  return {
    package: "@earendil-works/pi-ai",
    installed_version: "0.82.1",
    previous_version: previousVersion,
    current_version: currentVersion,
    is_adjacent_release: adjacent,
    published_at: "2026-08-14T00:00:00Z",
    integrity: "sha512-test",
    tarball_url: "https://example.test/pi-ai.tgz",
    git_head: "abc123",
    release_url: `https://github.com/earendil-works/pi/releases/tag/v${currentVersion}`,
    compare_url: `https://github.com/earendil-works/pi/compare/v${previousVersion}...v${currentVersion}`,
    changelog_md: "## Added",
    changed_files: ["packages/ai/src/index.ts"],
    diff_stat: "1 file changed",
    package_json_diff: null,
    workflow_run_url: "https://github.com/letta-ai/letta-code/actions/runs/1",
  };
}
