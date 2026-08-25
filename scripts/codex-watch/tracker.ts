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
  audit_cursor_tag: string | null;
  audit_cursor_validated: boolean;
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
    audit_cursor_tag: null,
    audit_cursor_validated: true,
    last_checked_tag: null,
    last_checked_at: null,
    processed: [],
  };
}

export function parseTrackerState(body: string): TrackerState {
  const start = body.indexOf(STATE_START);
  if (start === -1) throw new Error("Codex tracker hidden state is missing");

  const jsonStart = start + STATE_START.length;
  const end = body.indexOf(STATE_END, jsonStart);
  if (end === -1) throw new Error("Codex tracker hidden state is incomplete");

  try {
    return normalizeState(JSON.parse(body.slice(jsonStart, end).trim()));
  } catch (error) {
    throw new Error("Codex tracker hidden state is invalid", { cause: error });
  }
}

export function isTerminalOutcome(outcome: TrackerOutcome): boolean {
  return outcome !== "error";
}

export function hasProcessedRange(
  state: TrackerState,
  previousTag: string,
  currentTag: string,
): boolean {
  return state.processed.some(
    (entry) =>
      entry.previous_tag === previousTag &&
      entry.tag === currentTag &&
      isTerminalOutcome(entry.outcome),
  );
}

export function getCodexAuditCursorTag(state: TrackerState): string | null {
  return state.audit_cursor_tag;
}

export function validateLegacyCodexAuditCursor(
  state: TrackerState,
  stableTags: string[],
): TrackerState {
  if (state.audit_cursor_validated) return state;

  let tag = state.audit_cursor_tag;
  while (tag !== null) {
    const entry = state.processed.find(
      (candidate) =>
        candidate.tag === tag && isTerminalOutcome(candidate.outcome),
    );
    if (!entry) break;
    const currentIndex = stableTags.indexOf(entry.tag);
    if (
      currentIndex < 1 ||
      stableTags[currentIndex - 1] !== entry.previous_tag
    ) {
      throw new Error(
        `Legacy Codex tracker range is not adjacent: ${entry.previous_tag}...${entry.tag}`,
      );
    }
    tag = entry.previous_tag;
  }

  return { ...state, audit_cursor_validated: true };
}

export function advanceCodexAuditCursor(
  state: TrackerState,
  previousTag: string,
  currentTag: string,
  isAdjacentRelease: boolean,
): TrackerState {
  if (!isAdjacentRelease || state.audit_cursor_tag !== previousTag)
    return state;
  if (!hasProcessedRange(state, previousTag, currentTag)) {
    throw new Error(
      `Cannot advance Codex audit cursor without terminal ${previousTag}...${currentTag}`,
    );
  }
  return { ...state, audit_cursor_tag: currentTag };
}

export function recordAnalysis(
  state: TrackerState,
  options: RecordAnalysisOptions,
): TrackerState {
  const processedAt = options.processedAt ?? new Date().toISOString();
  return upsertTrackerEntry(
    state,
    {
      tag: options.analysis.current_tag,
      previous_tag: options.analysis.previous_tag,
      verdict: options.analysis.verdict,
      outcome: options.outcome,
      pr_url: options.prUrl ?? null,
      notes: options.notes,
      processed_at: processedAt,
      compare_url: options.analysis.compare_url,
      workflow_run_url: options.analysis.workflow_run_url,
    },
    options.analysis.is_adjacent_release,
  );
}

export function upsertTrackerEntry(
  state: TrackerState,
  entry: TrackerEntry,
  advanceAuditCursor = true,
): TrackerState {
  let auditCursorTag = state.audit_cursor_tag;
  if (auditCursorTag === null && !advanceAuditCursor) {
    auditCursorTag = entry.previous_tag;
  } else if (
    advanceAuditCursor &&
    entry.outcome === "error" &&
    auditCursorTag === null
  ) {
    auditCursorTag = entry.previous_tag;
  } else if (
    advanceAuditCursor &&
    isTerminalOutcome(entry.outcome) &&
    (auditCursorTag === null || entry.previous_tag === auditCursorTag)
  ) {
    auditCursorTag = entry.tag;
  }

  const candidates = [
    entry,
    ...state.processed.filter(
      (existing) =>
        existing.tag !== entry.tag ||
        existing.previous_tag !== entry.previous_tag,
    ),
  ];
  let processed = candidates.slice(0, HIDDEN_STATE_LIMIT);
  if (
    auditCursorTag !== null &&
    !isSupportedAuditCursor(processed, auditCursorTag)
  ) {
    const support = candidates.find((candidate) =>
      isAuditCursorSupportEntry(candidate, auditCursorTag),
    );
    if (!support) throw new Error("Codex audit cursor has no supporting entry");
    processed = [...processed.slice(0, HIDDEN_STATE_LIMIT - 1), support];
  }

  return {
    audit_cursor_tag: auditCursorTag,
    audit_cursor_validated: state.audit_cursor_validated,
    last_checked_tag: entry.tag,
    last_checked_at: entry.processed_at,
    processed,
  };
}

export function renderTrackerBody(state: TrackerState): string {
  const normalized = normalizeState(state);
  const parts: string[] = [
    "Central tracker for Amelia-driven Codex upstream drift monitoring.",
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
  if (!isRecord(value)) throw new TypeError("tracker state must be an object");
  if (
    !Array.isArray(value.processed) ||
    !value.processed.every(isTrackerEntry)
  ) {
    throw new TypeError("tracker processed entries are invalid");
  }
  if (
    value.last_checked_tag !== null &&
    typeof value.last_checked_tag !== "string"
  ) {
    throw new TypeError("tracker last_checked_tag is invalid");
  }
  if (
    value.last_checked_at !== null &&
    typeof value.last_checked_at !== "string"
  ) {
    throw new TypeError("tracker last_checked_at is invalid");
  }

  const processed = value.processed.slice(
    0,
    HIDDEN_STATE_LIMIT,
  ) as TrackerEntry[];
  const lastCheckedTag = value.last_checked_tag as string | null;
  const lastChecked =
    lastCheckedTag === null
      ? null
      : processed.find((entry) => entry.tag === lastCheckedTag);
  if (lastCheckedTag === null ? processed.length > 0 : !lastChecked) {
    throw new TypeError("tracker last_checked_tag is inconsistent");
  }

  let auditCursorTag: string | null;
  let auditCursorValidated: boolean;
  if (value.audit_cursor_tag === undefined) {
    auditCursorTag = deriveLegacyAuditCursor(processed);
    auditCursorValidated = false;
  } else if (
    (value.audit_cursor_tag === null ||
      typeof value.audit_cursor_tag === "string") &&
    value.audit_cursor_validated === true
  ) {
    auditCursorTag = value.audit_cursor_tag;
    auditCursorValidated = true;
  } else {
    throw new TypeError("tracker audit cursor is invalid");
  }
  if (auditCursorTag !== null && !isStableTag(auditCursorTag)) {
    throw new TypeError("tracker audit_cursor_tag is invalid");
  }
  if (auditCursorTag === null && processed.length > 0) {
    throw new TypeError("tracker audit_cursor_tag is missing");
  }
  if (
    auditCursorTag !== null &&
    !isSupportedAuditCursor(processed, auditCursorTag)
  ) {
    throw new TypeError("tracker audit_cursor_tag is inconsistent");
  }

  return {
    audit_cursor_tag: auditCursorTag,
    audit_cursor_validated: auditCursorValidated,
    last_checked_tag: lastCheckedTag,
    last_checked_at: value.last_checked_at as string | null,
    processed,
  };
}

function isSupportedAuditCursor(
  processed: TrackerEntry[],
  cursorTag: string,
): boolean {
  return processed.some((entry) => isAuditCursorSupportEntry(entry, cursorTag));
}

function isAuditCursorSupportEntry(
  entry: TrackerEntry,
  cursorTag: string,
): boolean {
  return (
    (entry.tag === cursorTag && isTerminalOutcome(entry.outcome)) ||
    entry.previous_tag === cursorTag
  );
}

function deriveLegacyAuditCursor(processed: TrackerEntry[]): string | null {
  const terminal = processed.filter((entry) =>
    isTerminalOutcome(entry.outcome),
  );
  if (terminal.length === 0) {
    const errorBaselines = [
      ...new Set(
        processed
          .filter((entry) => entry.outcome === "error")
          .map((entry) => entry.previous_tag),
      ),
    ];
    if (errorBaselines.length > 1) {
      throw new TypeError("legacy tracker error baselines are ambiguous");
    }
    return errorBaselines[0] ?? null;
  }

  const tags = terminal.map((entry) => entry.tag);
  if (new Set(tags).size !== tags.length) {
    throw new TypeError("legacy tracker terminal tags are duplicated");
  }
  const previousTags = new Set(terminal.map((entry) => entry.previous_tag));
  const endpoints = tags.filter((tag) => !previousTags.has(tag));
  if (endpoints.length !== 1) {
    throw new TypeError("legacy tracker audit chain is ambiguous");
  }
  return endpoints[0] ?? null;
}

function isTrackerEntry(value: unknown): value is TrackerEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.tag === "string" &&
    isStableTag(value.tag) &&
    typeof value.previous_tag === "string" &&
    isStableTag(value.previous_tag) &&
    isVerdict(value.verdict) &&
    isOutcome(value.outcome) &&
    (typeof value.pr_url === "string" || value.pr_url === null) &&
    typeof value.notes === "string" &&
    typeof value.processed_at === "string" &&
    typeof value.compare_url === "string" &&
    typeof value.workflow_run_url === "string"
  );
}

function isStableTag(value: string): boolean {
  return /^(?:rust-v|v)?\d+\.\d+\.\d+$/.test(value);
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
