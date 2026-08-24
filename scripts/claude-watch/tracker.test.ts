import { describe, expect, test } from "bun:test";
import {
  emptyTrackerState,
  hasProcessedCandidate,
  parseTrackerState,
  recordAnalysis,
  renderTrackerBody,
  serializeTrackerState,
  TRACKER_ATTEMPT_HISTORY_LIMIT,
  TRACKER_HISTORY_LIMIT,
} from "./tracker.ts";
import type { ClaudeWatchAnalysis } from "./types.ts";

function analysis(candidateId = "2.1.0"): ClaudeWatchAnalysis {
  return {
    schema_version: 1,
    candidate_id: candidateId,
    previous_candidate_id: "2.0.0",
    previous_version: "2.0.0",
    current_version: candidateId,
    is_bootstrap: false,
    release_url: `https://example.test/releases/${candidateId}`,
    release_notes_md: "notes",
    npm_integrity: `sha512-package-${candidateId}`,
    npm_published_at: "2026-08-01T00:00:00Z",
    release_published_at: "2026-08-01T00:00:00Z",
    dist_tags: { latest: candidateId, stable: candidateId, next: null },
    docs_digest: `docs-${candidateId}`,
    runtime_digest: `runtime-${candidateId}`,
    docs_diff: {
      added_pages: [],
      removed_pages: [],
      changed_pages: [],
      watched_page_diffs: [],
      tools: { added: [], removed: [], changed: [] },
      cli: { added: [], removed: [], changed: [] },
      settings: { added: [], removed: [], changed: [] },
      env_vars: { added: [], removed: [], changed: [] },
      permission_rules: { added: [], removed: [], changed: [] },
    },
    previous_runtime_snapshot: null,
    runtime_snapshot: null,
    runtime_diff: null,
    verdict: "no-op",
    verdict_reasons: [],
    errors: [],
    workflow_run_url: "https://example.test/actions/1",
    state_base_sha: null,
    state_snapshot_candidate_id: "2.0.0",
  };
}

describe("Claude tracker", () => {
  test("uses a Claude-only hidden marker and parses malformed state safely", () => {
    expect(parseTrackerState("plain text")).toEqual(emptyTrackerState());
    expect(
      parseTrackerState("<!-- claude-watch-tracker-state\n{nope}\n-->"),
    ).toEqual(emptyTrackerState());
    expect(
      parseTrackerState('<!-- codex-agent-watch-state\n{"processed":[]}\n-->'),
    ).toEqual(emptyTrackerState());
  });

  test("round trips digests and terminal state", () => {
    const state = recordAnalysis(emptyTrackerState(), {
      analysis: analysis(),
      outcome: "recorded_noop",
      notes: "nothing watched changed",
      stateCommitSha: "abc123",
      processedAt: "2026-08-01T01:00:00Z",
    });
    expect(parseTrackerState(serializeTrackerState(state))).toEqual(state);
    expect(state.processed[0]).toMatchObject({
      candidate_id: "2.1.0",
      package_digest: "sha512-package-2.1.0",
      docs_digest: "docs-2.1.0",
      runtime_digest: "runtime-2.1.0",
      state_commit_sha: "abc123",
    });
    expect(hasProcessedCandidate(state, "2.1.0")).toBe(true);
  });

  test("keeps errors nonterminal and accumulates bounded retry history", () => {
    let state = emptyTrackerState();
    for (
      let attempt = 0;
      attempt < TRACKER_ATTEMPT_HISTORY_LIMIT + 4;
      attempt++
    ) {
      state = recordAnalysis(state, {
        analysis: analysis(),
        outcome: "error",
        notes: "retryable",
        error: `failure ${attempt}`,
        processedAt: `2026-08-01T01:${String(attempt).padStart(2, "0")}:00Z`,
      });
    }
    expect(state.processed).toHaveLength(1);
    expect(state.processed[0]?.attempts).toHaveLength(
      TRACKER_ATTEMPT_HISTORY_LIMIT,
    );
    expect(state.processed[0]?.errors).toHaveLength(
      TRACKER_ATTEMPT_HISTORY_LIMIT,
    );
    expect(hasProcessedCandidate(state, "2.1.0")).toBe(false);

    state = recordAnalysis(state, {
      analysis: { ...analysis(), verdict: "tool contract review needed" },
      outcome: "pr_created",
      notes: "fixed",
      prUrl: "https://example.test/pull/1",
      stateCommitSha: "def456",
    });
    expect(state.processed).toHaveLength(1);
    expect(state.processed[0]?.attempts).toHaveLength(
      TRACKER_ATTEMPT_HISTORY_LIMIT,
    );
    expect(hasProcessedCandidate(state, "2.1.0")).toBe(true);
  });

  test("bounds candidate history and shows only actionable non-noops", () => {
    let state = emptyTrackerState();
    for (let index = 0; index < TRACKER_HISTORY_LIMIT + 5; index++) {
      state = recordAnalysis(state, {
        analysis: analysis(`2.${index}.0`),
        outcome: "recorded_noop",
        notes: `noop ${index}`,
      });
    }
    expect(state.processed).toHaveLength(TRACKER_HISTORY_LIMIT);
    expect(renderTrackerBody(state)).toContain(
      "_No actionable Claude changes recorded yet._",
    );
    expect(renderTrackerBody(state)).not.toContain("| 2.54.0 | no-op |");

    const actionable = recordAnalysis(state, {
      analysis: {
        ...analysis("3.0.0"),
        verdict: "harness behavior review needed",
      },
      outcome: "needs_human_review",
      notes: "inspect hooks | carefully",
    });
    const body = renderTrackerBody(actionable);
    expect(body).toContain("| 3.0.0 | harness behavior review needed |");
    expect(body).toContain("inspect hooks \\| carefully");
  });
});
