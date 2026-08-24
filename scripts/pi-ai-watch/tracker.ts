import type { PiAiWatchAnalysis } from "./release-analysis.ts";

const STATE_START = "<!-- pi-ai-watch-state";
const STATE_END = "-->";
const HISTORY_LIMIT = 50;
const VISIBLE_LIMIT = 20;

export type TrackerOutcome =
  | "no_upgrade"
  | "pr_created"
  | "needs_human_review"
  | "error";

export interface TrackerEntry {
  version: string;
  previous_version: string;
  installed_version: string;
  outcome: TrackerOutcome;
  pr_url: string | null;
  notes: string;
  processed_at: string;
  compare_url: string;
  workflow_run_url: string;
}

export interface TrackerState {
  audit_cursor_version: string;
  last_checked_version: string | null;
  last_checked_at: string | null;
  processed: TrackerEntry[];
}

export interface RecordAnalysisOptions {
  analysis: PiAiWatchAnalysis;
  outcome: TrackerOutcome;
  notes: string;
  prUrl?: string | null;
  processedAt?: string;
}

export function initialTrackerState(installedVersion: string): TrackerState {
  assertStableVersion(installedVersion);
  return {
    audit_cursor_version: installedVersion,
    last_checked_version: null,
    last_checked_at: null,
    processed: [],
  };
}

export function parseTrackerState(body: string): TrackerState {
  const start = body.indexOf(STATE_START);
  if (start === -1) throw new Error("pi-ai tracker hidden state is missing");
  const jsonStart = start + STATE_START.length;
  const end = body.indexOf(STATE_END, jsonStart);
  if (end === -1) throw new Error("pi-ai tracker hidden state is incomplete");

  try {
    return normalizeState(JSON.parse(body.slice(jsonStart, end).trim()));
  } catch (error) {
    throw new Error("pi-ai tracker hidden state is invalid", { cause: error });
  }
}

export function recordAnalysis(
  state: TrackerState,
  options: RecordAnalysisOptions,
): TrackerState {
  const entry: TrackerEntry = {
    version: options.analysis.current_version,
    previous_version: options.analysis.previous_version,
    installed_version: options.analysis.installed_version,
    outcome: options.outcome,
    pr_url: options.prUrl ?? null,
    notes: options.notes,
    processed_at: options.processedAt ?? new Date().toISOString(),
    compare_url: options.analysis.compare_url,
    workflow_run_url: options.analysis.workflow_run_url,
  };
  const processed = [
    entry,
    ...state.processed.filter(
      (existing) =>
        existing.version !== entry.version ||
        existing.previous_version !== entry.previous_version,
    ),
  ].slice(0, HISTORY_LIMIT);

  const advancesCursor =
    options.analysis.is_adjacent_release &&
    entry.previous_version === state.audit_cursor_version &&
    (entry.outcome === "no_upgrade" || entry.outcome === "needs_human_review");

  return {
    audit_cursor_version: advancesCursor
      ? entry.version
      : state.audit_cursor_version,
    last_checked_version: entry.version,
    last_checked_at: entry.processed_at,
    processed,
  };
}

export function hasRecordedOutcome(
  state: TrackerState,
  previousVersion: string,
  currentVersion: string,
): boolean {
  return state.processed.some(
    (entry) =>
      entry.previous_version === previousVersion &&
      entry.version === currentVersion &&
      entry.outcome !== "error",
  );
}

export function hasCompletedRange(
  state: TrackerState,
  previousVersion: string,
  currentVersion: string,
): boolean {
  return state.processed.some(
    (entry) =>
      entry.previous_version === previousVersion &&
      entry.version === currentVersion &&
      (entry.outcome === "no_upgrade" ||
        entry.outcome === "needs_human_review"),
  );
}

export function getPendingPrForCursor(
  state: TrackerState,
): TrackerEntry | null {
  return (
    state.processed.find(
      (entry) =>
        entry.previous_version === state.audit_cursor_version &&
        entry.outcome === "pr_created" &&
        entry.pr_url,
    ) ?? null
  );
}

export function advanceMergedPr(
  state: TrackerState,
  currentVersion: string,
): TrackerState {
  const pending = getPendingPrForCursor(state);
  if (!pending || pending.version !== currentVersion) {
    throw new Error(`No pending pi-ai PR for ${currentVersion}`);
  }
  return { ...state, audit_cursor_version: currentVersion };
}

export function renderTrackerBody(state: TrackerState): string {
  const normalized = normalizeState(state);
  return `${[
    "Central tracker for Amelia-driven pi-ai dependency upgrade reviews.",
    "",
    `_Audit cursor: ${normalized.audit_cursor_version}._`,
    renderLastChecked(normalized),
    "",
    "## Recent reviews",
    "",
    renderTable(normalized),
    "",
    "## Hidden state",
    "",
    "The workflow uses the hidden JSON block below for ordered release processing and dedupe.",
    "",
    serializeTrackerState(normalized),
  ].join("\n")}\n`;
}

export function serializeTrackerState(state: TrackerState): string {
  const normalized = normalizeState(state);
  return `${STATE_START}\n${JSON.stringify(normalized, null, 2)}\n${STATE_END}`;
}

function renderLastChecked(state: TrackerState): string {
  if (!state.last_checked_version || !state.last_checked_at) {
    return "_Last checked: never._";
  }
  const latest = state.processed.find(
    (entry) => entry.version === state.last_checked_version,
  );
  const suffix = latest ? `, ${statusSummary(latest)}.` : ".";
  return `_Last checked: ${state.last_checked_version} at ${state.last_checked_at}${suffix}_`;
}

function renderTable(state: TrackerState): string {
  const entries = state.processed.slice(0, VISIBLE_LIMIT);
  if (entries.length === 0) return "_No pi-ai releases reviewed yet._";

  const rows = [
    "| Release | Installed | Outcome | PR | Notes |",
    "|---|---|---|---|---|",
  ];
  for (const entry of entries) {
    rows.push(
      `| [${entry.version}](${entry.compare_url}) | ${entry.installed_version} | ${entry.outcome} | ${renderPr(entry.pr_url)} | ${escapeTable(entry.notes)} |`,
    );
  }
  return rows.join("\n");
}

function statusSummary(entry: TrackerEntry): string {
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
  if (!isRecord(value)) throw new TypeError("tracker state must be an object");
  if (typeof value.audit_cursor_version !== "string") {
    throw new TypeError("tracker audit cursor is invalid");
  }
  assertStableVersion(value.audit_cursor_version);
  if (
    !Array.isArray(value.processed) ||
    !value.processed.every(isTrackerEntry)
  ) {
    throw new TypeError("tracker processed entries are invalid");
  }
  if (
    value.last_checked_version !== null &&
    typeof value.last_checked_version !== "string"
  ) {
    throw new TypeError("tracker last checked version is invalid");
  }
  if (
    value.last_checked_at !== null &&
    typeof value.last_checked_at !== "string"
  ) {
    throw new TypeError("tracker last checked time is invalid");
  }

  const processed = value.processed.slice(0, HISTORY_LIMIT) as TrackerEntry[];
  const lastCheckedVersion = value.last_checked_version as string | null;
  if (
    lastCheckedVersion !== null &&
    !processed.some((entry) => entry.version === lastCheckedVersion)
  ) {
    throw new TypeError("tracker last checked version is inconsistent");
  }

  return {
    audit_cursor_version: value.audit_cursor_version,
    last_checked_version: lastCheckedVersion,
    last_checked_at: value.last_checked_at as string | null,
    processed,
  };
}

function isTrackerEntry(value: unknown): value is TrackerEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.version === "string" &&
    isStableVersion(value.version) &&
    typeof value.previous_version === "string" &&
    isStableVersion(value.previous_version) &&
    typeof value.installed_version === "string" &&
    isStableVersion(value.installed_version) &&
    isOutcome(value.outcome) &&
    (typeof value.pr_url === "string" || value.pr_url === null) &&
    typeof value.notes === "string" &&
    typeof value.processed_at === "string" &&
    typeof value.compare_url === "string" &&
    typeof value.workflow_run_url === "string"
  );
}

function isOutcome(value: unknown): value is TrackerOutcome {
  return (
    value === "no_upgrade" ||
    value === "pr_created" ||
    value === "needs_human_review" ||
    value === "error"
  );
}

function assertStableVersion(version: string): void {
  if (!isStableVersion(version)) {
    throw new TypeError(`Invalid stable pi-ai version ${version}`);
  }
}

function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
