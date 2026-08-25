import { describe, expect, test } from "bun:test";
import type { CodexWatchAnalysis } from "./release-analysis.ts";
import {
  advanceCodexAuditCursor,
  emptyTrackerState,
  getCodexAuditCursorTag,
  hasProcessedRange,
  parseTrackerState,
  recordAnalysis,
  renderTrackerBody,
  serializeTrackerState,
  type TrackerEntry,
  upsertTrackerEntry,
  validateLegacyCodexAuditCursor,
} from "./tracker.ts";

function analysis(
  tag: string,
  verdict: CodexWatchAnalysis["verdict"] = "no-op",
): CodexWatchAnalysis {
  return {
    previous_tag: "rust-v0.1.0",
    current_tag: tag,
    is_adjacent_release: true,
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

function withoutAuditCursor(body: string): string {
  return body
    .replace(/ {2}"audit_cursor_tag": (?:null|"[^"]+"),\n/, "")
    .replace('  "audit_cursor_validated": true,\n', "");
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
  test("fails closed when hidden state is absent or malformed", () => {
    expect(() => parseTrackerState("plain body")).toThrow(
      "Codex tracker hidden state is missing",
    );
    expect(() =>
      parseTrackerState("<!-- codex-agent-watch-state\nnot json\n-->"),
    ).toThrow("Codex tracker hidden state is invalid");
    expect(() =>
      parseTrackerState(
        '<!-- codex-agent-watch-state\n{"last_checked_tag":null,"last_checked_at":null,"processed":[{}]}\n-->',
      ),
    ).toThrow("Codex tracker hidden state is invalid");
    expect(() =>
      parseTrackerState(
        '<!-- codex-agent-watch-state\n{"audit_cursor_tag":null,"last_checked_tag":"rust-v0.2.0","last_checked_at":"2026-08-20T00:00:00Z","processed":[]}\n-->',
      ),
    ).toThrow("Codex tracker hidden state is invalid");
  });

  test("fails closed on an unsupported durable cursor", () => {
    const state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(1, "no_local_impact"),
    );
    const body = renderTrackerBody(state).replace(
      '"audit_cursor_tag": "rust-v0.1.0"',
      '"audit_cursor_tag": "rust-v0.5.0"',
    );

    expect(() => parseTrackerState(body)).toThrow(
      "Codex tracker hidden state is invalid",
    );
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

  test("derives the durable cursor from legacy hidden state", () => {
    const state = recordAnalysis(emptyTrackerState(), {
      analysis: analysis("rust-v0.2.0"),
      outcome: "recorded_noop",
      notes: "no watched changes",
      processedAt: "2026-07-02T00:00:00.000Z",
    });
    const legacyBody = withoutAuditCursor(renderTrackerBody(state));

    const legacy = parseTrackerState(legacyBody);
    expect(legacy.audit_cursor_validated).toBe(false);
    const migrated = validateLegacyCodexAuditCursor(legacy, [
      "rust-v0.1.0",
      "rust-v0.2.0",
    ]);
    expect(migrated.audit_cursor_validated).toBe(true);
    expect(getCodexAuditCursorTag(migrated)).toBe("rust-v0.2.0");
  });

  test("migrates a legacy cursor independently of an older replay", () => {
    let state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(1, "no_local_impact"),
    );
    state = upsertTrackerEntry(state, entry(2, "no_local_impact"));
    state = upsertTrackerEntry(state, entry(3, "no_local_impact"));
    state = upsertTrackerEntry(state, entry(1, "no_local_impact"));

    const legacy = parseTrackerState(
      withoutAuditCursor(renderTrackerBody(state)),
    );
    const migrated = validateLegacyCodexAuditCursor(legacy, [
      "rust-v0.0.0",
      "rust-v0.1.0",
      "rust-v0.2.0",
      "rust-v0.3.0",
    ]);
    expect(migrated.last_checked_tag).toBe("rust-v0.1.0");
    expect(getCodexAuditCursorTag(migrated)).toBe("rust-v0.3.0");
  });

  test("fails closed on a disconnected future legacy replay", () => {
    let state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(1, "no_local_impact"),
    );
    state = upsertTrackerEntry(state, entry(2, "no_local_impact"));
    state = upsertTrackerEntry(state, entry(5, "no_local_impact"));

    expect(() =>
      parseTrackerState(withoutAuditCursor(renderTrackerBody(state))),
    ).toThrow("Codex tracker hidden state is invalid");
  });

  test("fails closed on a cumulative legacy replay", () => {
    const cumulative = {
      ...analysis("rust-v0.5.0", "tool-surface review needed"),
      is_adjacent_release: false,
    };
    const state = recordAnalysis(emptyTrackerState(), {
      analysis: cumulative,
      outcome: "no_local_impact",
      notes: "legacy cumulative replay",
    });
    const legacy = parseTrackerState(
      withoutAuditCursor(renderTrackerBody(state)),
    );

    expect(() =>
      validateLegacyCodexAuditCursor(legacy, [
        "rust-v0.1.0",
        "rust-v0.2.0",
        "rust-v0.3.0",
        "rust-v0.4.0",
        "rust-v0.5.0",
      ]),
    ).toThrow("Legacy Codex tracker range is not adjacent");
  });

  test("records noops in hidden state without adding visible table rows", () => {
    const state = recordAnalysis(emptyTrackerState(), {
      analysis: analysis("rust-v0.2.0"),
      outcome: "recorded_noop",
      notes: "no watched tool-surface changes detected",
      processedAt: "2026-07-02T00:00:00.000Z",
    });

    const body = renderTrackerBody(state);
    expect(
      hasProcessedRange(parseTrackerState(body), "rust-v0.1.0", "rust-v0.2.0"),
    ).toBe(true);
    expect(body).toContain("_No actionable releases recorded yet._");
    expect(body).toContain("no watched changes");
  });

  test("retries an errored release from its previous tag", () => {
    let state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(1, "recorded_noop"),
    );
    state = upsertTrackerEntry(state, entry(2, "error"));

    expect(hasProcessedRange(state, "rust-v0.1.0", "rust-v0.2.0")).toBe(false);
    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.1.0");

    state = upsertTrackerEntry(state, entry(2, "no_local_impact"));
    expect(hasProcessedRange(state, "rust-v0.1.0", "rust-v0.2.0")).toBe(true);
    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.2.0");
  });

  test("uses an errored release baseline when no terminal entry exists", () => {
    const state = upsertTrackerEntry(emptyTrackerState(), entry(2, "error"));

    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.1.0");
  });

  test("does not regress the cursor after an older replay", () => {
    let state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(10, "no_local_impact"),
    );
    state = upsertTrackerEntry(state, entry(5, "no_local_impact"));

    expect(state.last_checked_tag).toBe("rust-v0.5.0");
    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.10.0");
  });

  test("does not let a future replay skip an errored release", () => {
    let state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(1, "no_local_impact"),
    );
    state = upsertTrackerEntry(state, entry(2, "error"));
    state = upsertTrackerEntry(state, entry(5, "no_local_impact"));

    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.1.0");

    state = upsertTrackerEntry(state, entry(2, "no_local_impact"));
    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.2.0");
  });

  test("does not advance for an explicit non-adjacent range", () => {
    const initial = upsertTrackerEntry(
      emptyTrackerState(),
      entry(1, "no_local_impact"),
    );
    const cumulative = {
      ...analysis("rust-v0.5.0", "tool-surface review needed"),
      is_adjacent_release: false,
    };
    const state = recordAnalysis(initial, {
      analysis: cumulative,
      outcome: "no_local_impact",
      notes: "explicit cumulative replay",
    });

    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.1.0");
    expect(
      getCodexAuditCursorTag(
        advanceCodexAuditCursor(state, "rust-v0.1.0", "rust-v0.5.0", false),
      ),
    ).toBe("rust-v0.1.0");
  });

  test("advances across an already audited adjacent range", () => {
    let state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(1, "no_local_impact"),
    );
    state = upsertTrackerEntry(state, entry(3, "no_local_impact"));
    state = upsertTrackerEntry(state, entry(2, "no_local_impact"));

    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.2.0");
    state = advanceCodexAuditCursor(state, "rust-v0.2.0", "rust-v0.3.0", true);
    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.3.0");
  });

  test("retains the durable cursor entry when history is truncated", () => {
    let state = upsertTrackerEntry(
      emptyTrackerState(),
      entry(100, "no_local_impact"),
    );
    for (let index = 1; index <= 60; index += 1) {
      state = upsertTrackerEntry(state, entry(index, "no_local_impact"));
    }

    expect(state.processed).toHaveLength(50);
    expect(state.processed.some(({ tag }) => tag === "rust-v0.100.0")).toBe(
      true,
    );
    expect(getCodexAuditCursorTag(state)).toBe("rust-v0.100.0");
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
