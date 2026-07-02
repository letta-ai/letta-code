import { describe, expect, test } from "bun:test";
import type { CodexWatchAnalysis } from "./release-analysis.ts";
import {
  emptyTrackerState,
  hasProcessedTag,
  parseTrackerState,
  recordAnalysis,
  renderTrackerBody,
  serializeTrackerState,
  type TrackerEntry,
  upsertTrackerEntry,
} from "./tracker.ts";

function analysis(
  tag: string,
  verdict: CodexWatchAnalysis["verdict"] = "no-op",
): CodexWatchAnalysis {
  return {
    previous_tag: "rust-v0.1.0",
    current_tag: tag,
    release_url: `https://github.com/openai/codex/releases/tag/${tag}`,
    release_notes_md: "",
    verdict,
    models_diff: null,
    prompt_md_changed: false,
    prompt_md_diff_preview: null,
    path_changes: [],
    workflow_run_url: "https://github.com/letta-ai/letta-code/actions/runs/1",
    compare_url: `https://github.com/openai/codex/compare/rust-v0.1.0...${tag}`,
    changed_files: [],
  };
}

function entry(index: number, outcome: TrackerEntry["outcome"]): TrackerEntry {
  const verdict =
    outcome === "recorded_noop" ? "no-op" : "tool-surface review needed";
  return {
    tag: `rust-v0.${index}.0`,
    previous_tag: `rust-v0.${index - 1}.0`,
    verdict,
    outcome,
    pr_url:
      outcome === "pr_created"
        ? `https://github.com/letta-ai/letta-code/pull/${index}`
        : null,
    notes: `notes ${index}`,
    processed_at: `2026-07-02T00:${String(index).padStart(2, "0")}:00.000Z`,
    compare_url: `https://github.com/openai/codex/compare/rust-v0.${index - 1}.0...rust-v0.${index}.0`,
    workflow_run_url: "https://github.com/letta-ai/letta-code/actions/runs/1",
  };
}

describe("tracker state", () => {
  test("returns empty state when hidden state is absent or malformed", () => {
    expect(parseTrackerState("plain body")).toEqual(emptyTrackerState());
    expect(
      parseTrackerState("<!-- codex-agent-watch-state\nnot json\n-->"),
    ).toEqual(emptyTrackerState());
  });

  test("round-trips hidden state through rendered body", () => {
    const state = recordAnalysis(emptyTrackerState(), {
      analysis: analysis("rust-v0.2.0", "tool-surface review needed"),
      outcome: "no_local_impact",
      notes: "upstream-only router change",
      processedAt: "2026-07-02T00:00:00.000Z",
    });

    const body = renderTrackerBody(state);
    expect(parseTrackerState(body)).toEqual(state);
    expect(body).toContain("rust-v0.2.0");
    expect(body).toContain("upstream-only router change");
  });

  test("records noops in hidden state without adding visible table rows", () => {
    const state = recordAnalysis(emptyTrackerState(), {
      analysis: analysis("rust-v0.2.0"),
      outcome: "recorded_noop",
      notes: "no watched tool-surface changes detected",
      processedAt: "2026-07-02T00:00:00.000Z",
    });

    const body = renderTrackerBody(state);
    expect(hasProcessedTag(parseTrackerState(body), "rust-v0.2.0")).toBe(true);
    expect(body).toContain("_No actionable releases recorded yet._");
    expect(body).toContain("no watched changes");
  });

  test("keeps the last 50 processed releases in hidden state", () => {
    let state = emptyTrackerState();
    for (let i = 1; i <= 60; i++) {
      state = upsertTrackerEntry(state, entry(i, "recorded_noop"));
    }

    expect(state.processed).toHaveLength(50);
    expect(state.processed[0]?.tag).toBe("rust-v0.60.0");
    expect(state.processed.at(-1)?.tag).toBe("rust-v0.11.0");
    expect(parseTrackerState(serializeTrackerState(state))).toEqual(state);
  });

  test("renders at most 20 non-noop rows", () => {
    let state = emptyTrackerState();
    for (let i = 1; i <= 25; i++) {
      state = upsertTrackerEntry(state, entry(i, "no_local_impact"));
    }

    const body = renderTrackerBody(state);
    expect(body).toContain("| [rust-v0.25.0]");
    expect(body).toContain("| [rust-v0.6.0]");
    expect(body).not.toContain("| [rust-v0.5.0]");
  });

  test("replaces an existing tag instead of duplicating it", () => {
    let state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(2, "recorded_noop"),
    );
    state = upsertTrackerEntry(state, {
      ...entry(2, "pr_created"),
      notes: "opened a fix",
    });

    expect(state.processed).toHaveLength(1);
    expect(state.processed[0]?.outcome).toBe("pr_created");
    expect(renderTrackerBody(state)).toContain("opened a fix");
  });
});
