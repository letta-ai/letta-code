import type { Verdict } from "./diff-models-json.ts";
import type { CodexWatchAnalysis } from "./release-analysis.ts";

const STATE_START = "<!-- codex-agent-watch-state";
const STATE_END = "-->";
const HIDDEN_STATE_LIMIT = 50;
const VISIBLE_INTERESTING_LIMIT = 20;

export type TrackerOutcome =
  | "recorded_noop"
  | "no_local_impact"
  | "pr_created"
  | "needs_human_review"
  | "error";

export interface TrackerEntry {
  tag: string;
  previous_tag: string;
  verdict: Verdict;
  outcome: TrackerOutcome;
  pr_url: string | null;
  notes: string;
  processed_at: string;
  compare_url: string;
  workflow_run_url: string;
}

export interface TrackerState {
  last_checked_tag: string | null;
  last_checked_at: string | null;
  processed: TrackerEntry[];
}

export interface RecordAnalysisOptions {
  analysis: CodexWatchAnalysis;
  outcome: TrackerOutcome;
  notes: string;
  prUrl?: string | null;
  processedAt?: string;
}

export function emptyTrackerState(): TrackerState {
  return {
    last_checked_tag: null,
    last_checked_at: null,
    processed: [],
  };
}

export function parseTrackerState(body: string): TrackerState {
  const start = body.indexOf(STATE_START);
  if (start === -1) return emptyTrackerState();

  const jsonStart = start + STATE_START.length;
  const end = body.indexOf(STATE_END, jsonStart);
  if (end === -1) return emptyTrackerState();

  try {
    return normalizeState(JSON.parse(body.slice(jsonStart, end).trim()));
  } catch {
    return emptyTrackerState();
  }
}

export function hasProcessedTag(state: TrackerState, tag: string): boolean {
  return state.processed.some((entry) => entry.tag === tag);
}

export function recordAnalysis(
  state: TrackerState,
  options: RecordAnalysisOptions,
): TrackerState {
  const processedAt = options.processedAt ?? new Date().toISOString();
  return upsertTrackerEntry(state, {
    tag: options.analysis.current_tag,
    previous_tag: options.analysis.previous_tag,
    verdict: options.analysis.verdict,
    outcome: options.outcome,
    pr_url: options.prUrl ?? null,
    notes: options.notes,
    processed_at: processedAt,
    compare_url: options.analysis.compare_url,
    workflow_run_url: options.analysis.workflow_run_url,
  });
}

export function upsertTrackerEntry(
  state: TrackerState,
  entry: TrackerEntry,
): TrackerState {
  const processed = [
    entry,
    ...state.processed.filter((existing) => existing.tag !== entry.tag),
  ].slice(0, HIDDEN_STATE_LIMIT);

  return {
    last_checked_tag: entry.tag,
    last_checked_at: entry.processed_at,
    processed,
  };
}

export function renderTrackerBody(state: TrackerState): string {
  const normalized = normalizeState(state);
  const parts: string[] = [
    "Central tracker for the Amelia-driven Codex upstream drift watch experiment.",
    "",
    "The legacy per-release `codex-release-watch.yml` issue workflow is still enabled as the baseline while this tracker bakes off the new automation path.",
    "",
    renderLastChecked(normalized),
    "",
    "## Recent actionable releases",
    "",
    renderInterestingTable(normalized),
    "",
    "## Hidden state",
    "",
    "The workflow uses the hidden JSON block below for dedupe and recent history.",
    "",
    serializeTrackerState(normalized),
  ];
  return `${parts.join("\n")}\n`;
}

export function serializeTrackerState(state: TrackerState): string {
  const normalized = normalizeState(state);
  return `${STATE_START}\n${JSON.stringify(normalized, null, 2)}\n${STATE_END}`;
}

export function isInterestingEntry(entry: TrackerEntry): boolean {
  return entry.verdict !== "no-op" || entry.outcome !== "recorded_noop";
}

function renderLastChecked(state: TrackerState): string {
  if (!state.last_checked_tag || !state.last_checked_at) {
    return "_Last checked: never._";
  }

  const latest = state.processed.find(
    (entry) => entry.tag === state.last_checked_tag,
  );
  const suffix = latest ? `, ${statusSummary(latest)}.` : ".";
  return `_Last checked: ${state.last_checked_tag} at ${state.last_checked_at}${suffix}_`;
}

function renderInterestingTable(state: TrackerState): string {
  const interesting = state.processed
    .filter(isInterestingEntry)
    .slice(0, VISIBLE_INTERESTING_LIMIT);

  if (interesting.length === 0) {
    return "_No actionable releases recorded yet._";
  }

  const rows = [
    "| Release | Verdict | Outcome | PR | Notes |",
    "|---|---|---|---|---|",
  ];
  for (const entry of interesting) {
    rows.push(
      `| [${escapeTable(entry.tag)}](${entry.compare_url}) | ${escapeTable(entry.verdict)} | ${escapeTable(entry.outcome)} | ${renderPr(entry.pr_url)} | ${escapeTable(entry.notes)} |`,
    );
  }
  return rows.join("\n");
}

function statusSummary(entry: TrackerEntry): string {
  if (entry.outcome === "recorded_noop") return "no watched changes";
  if (entry.outcome === "pr_created" && entry.pr_url) {
    return `PR created: ${entry.pr_url}`;
  }
  return entry.notes || entry.outcome;
}

function renderPr(prUrl: string | null): string {
  return prUrl ? `[PR](${prUrl})` : "-";
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function normalizeState(value: unknown): TrackerState {
  if (!isRecord(value)) return emptyTrackerState();

  const processed = Array.isArray(value.processed)
    ? value.processed.filter(isTrackerEntry).slice(0, HIDDEN_STATE_LIMIT)
    : [];

  return {
    last_checked_tag:
      typeof value.last_checked_tag === "string"
        ? value.last_checked_tag
        : null,
    last_checked_at:
      typeof value.last_checked_at === "string" ? value.last_checked_at : null,
    processed,
  };
}

function isTrackerEntry(value: unknown): value is TrackerEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.tag === "string" &&
    typeof value.previous_tag === "string" &&
    isVerdict(value.verdict) &&
    isOutcome(value.outcome) &&
    (typeof value.pr_url === "string" || value.pr_url === null) &&
    typeof value.notes === "string" &&
    typeof value.processed_at === "string" &&
    typeof value.compare_url === "string" &&
    typeof value.workflow_run_url === "string"
  );
}

function isVerdict(value: unknown): value is Verdict {
  return (
    value === "no-op" ||
    value === "prompt-only update" ||
    value === "tool-schema update needed" ||
    value === "tool-surface review needed" ||
    value === "manual review required"
  );
}

function isOutcome(value: unknown): value is TrackerOutcome {
  return (
    value === "recorded_noop" ||
    value === "no_local_impact" ||
    value === "pr_created" ||
    value === "needs_human_review" ||
    value === "error"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
