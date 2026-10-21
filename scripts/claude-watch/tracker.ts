import type {
  ClaudeWatchAnalysis,
  ClaudeWatchOutcome,
  ClaudeWatchVerdict,
} from "./types.ts";

/** Deliberately different from the Codex watcher marker. */
export const CLAUDE_TRACKER_STATE_START = "<!-- claude-watch-tracker-state";
export const CLAUDE_TRACKER_STATE_END = "-->";
export const TRACKER_HISTORY_LIMIT = 50;
export const TRACKER_ATTEMPT_HISTORY_LIMIT = 10;
export const TRACKER_ERROR_HISTORY_LIMIT = 10;
export const VISIBLE_ACTIONABLE_LIMIT = 20;

const TERMINAL_OUTCOMES: ReadonlySet<ClaudeWatchOutcome> = new Set([
  "recorded_noop",
  "no_local_impact",
  "pr_created",
  "needs_human_review",
]);

export interface ClaudeTrackerAttempt {
  attempted_at: string;
  workflow_run_url: string;
  outcome: ClaudeWatchOutcome;
  error: string | null;
}

export interface ClaudeTrackerError {
  occurred_at: string;
  workflow_run_url: string;
  message: string;
}

export interface ClaudeTrackerEntry {
  candidate_id: string;
  package_digest: string;
  docs_digest: string;
  runtime_digest: string | null;
  verdict: ClaudeWatchVerdict;
  outcome: ClaudeWatchOutcome;
  pr_url: string | null;
  notes: string;
  processed_at: string;
  workflow_run_url: string;
  attempts: ClaudeTrackerAttempt[];
  errors: ClaudeTrackerError[];
  state_commit_sha: string | null;
}

export interface ClaudeTrackerState {
  last_checked_candidate_id: string | null;
  last_checked_at: string | null;
  processed: ClaudeTrackerEntry[];
}

export interface RecordClaudeAnalysisOptions {
  analysis: ClaudeWatchAnalysis;
  outcome: ClaudeWatchOutcome;
  notes: string;
  prUrl?: string | null;
  stateCommitSha?: string | null;
  error?: string | null;
  processedAt?: string;
}

export function emptyTrackerState(): ClaudeTrackerState {
  return {
    last_checked_candidate_id: null,
    last_checked_at: null,
    processed: [],
  };
}

export function isTerminalOutcome(outcome: ClaudeWatchOutcome): boolean {
  return TERMINAL_OUTCOMES.has(outcome);
}

export function findTrackerEntry(
  state: ClaudeTrackerState,
  candidateId: string,
): ClaudeTrackerEntry | undefined {
  return state.processed.find((entry) => entry.candidate_id === candidateId);
}

/** Errors are retryable and therefore do not count as processed. */
export function hasProcessedCandidate(
  state: ClaudeTrackerState,
  candidateId: string,
): boolean {
  const entry = findTrackerEntry(state, candidateId);
  return entry !== undefined && isTerminalOutcome(entry.outcome);
}

export function parseTrackerState(body: string): ClaudeTrackerState {
  const start = body.indexOf(CLAUDE_TRACKER_STATE_START);
  if (start < 0) return emptyTrackerState();
  const jsonStart = start + CLAUDE_TRACKER_STATE_START.length;
  const end = body.indexOf(CLAUDE_TRACKER_STATE_END, jsonStart);
  if (end < 0) return emptyTrackerState();
  try {
    return normalizeState(JSON.parse(body.slice(jsonStart, end).trim()));
  } catch {
    return emptyTrackerState();
  }
}

export function serializeTrackerState(state: ClaudeTrackerState): string {
  return `${CLAUDE_TRACKER_STATE_START}\n${JSON.stringify(normalizeState(state), null, 2)}\n${CLAUDE_TRACKER_STATE_END}`;
}

export function recordAnalysis(
  state: ClaudeTrackerState,
  options: RecordClaudeAnalysisOptions,
): ClaudeTrackerState {
  const processedAt = options.processedAt ?? new Date().toISOString();
  const previous = findTrackerEntry(state, options.analysis.candidate_id);
  const error = options.error ?? options.analysis.errors.at(-1) ?? null;
  const attempt: ClaudeTrackerAttempt = {
    attempted_at: processedAt,
    workflow_run_url: options.analysis.workflow_run_url,
    outcome: options.outcome,
    error,
  };
  const errors = error
    ? [
        {
          occurred_at: processedAt,
          workflow_run_url: options.analysis.workflow_run_url,
          message: error,
        },
        ...(previous?.errors ?? []),
      ].slice(0, TRACKER_ERROR_HISTORY_LIMIT)
    : (previous?.errors ?? []);

  return upsertTrackerEntry(state, {
    candidate_id: options.analysis.candidate_id,
    package_digest: options.analysis.npm_integrity,
    docs_digest: options.analysis.docs_digest,
    runtime_digest: options.analysis.runtime_digest,
    verdict: options.analysis.verdict,
    outcome: options.outcome,
    pr_url: options.prUrl ?? previous?.pr_url ?? null,
    notes: options.notes,
    processed_at: processedAt,
    workflow_run_url: options.analysis.workflow_run_url,
    attempts: [attempt, ...(previous?.attempts ?? [])].slice(
      0,
      TRACKER_ATTEMPT_HISTORY_LIMIT,
    ),
    errors,
    state_commit_sha:
      options.stateCommitSha ?? previous?.state_commit_sha ?? null,
  });
}

/** Upserts by candidate id, so retries never create duplicate history rows. */
export function upsertTrackerEntry(
  state: ClaudeTrackerState,
  entry: ClaudeTrackerEntry,
): ClaudeTrackerState {
  const normalizedEntry = normalizeEntry(entry);
  if (!normalizedEntry) return normalizeState(state);
  return {
    last_checked_candidate_id: normalizedEntry.candidate_id,
    last_checked_at: normalizedEntry.processed_at,
    processed: [
      normalizedEntry,
      ...normalizeState(state).processed.filter(
        (item) => item.candidate_id !== normalizedEntry.candidate_id,
      ),
    ].slice(0, TRACKER_HISTORY_LIMIT),
  };
}

/** True only for entries useful to a human; no-op and transient errors stay hidden. */
export function isActionableEntry(entry: ClaudeTrackerEntry): boolean {
  return (
    entry.outcome === "pr_created" ||
    entry.outcome === "needs_human_review" ||
    (entry.outcome === "no_local_impact" && entry.verdict !== "no-op")
  );
}

export function renderTrackerBody(state: ClaudeTrackerState): string {
  const normalized = normalizeState(state);
  const rows = normalized.processed
    .filter(isActionableEntry)
    .slice(0, VISIBLE_ACTIONABLE_LIMIT);
  const table =
    rows.length === 0
      ? "_No actionable Claude changes recorded yet._"
      : [
          "| Candidate | Verdict | Outcome | PR | Notes |",
          "|---|---|---|---|---|",
          ...rows.map(
            (entry) =>
              `| ${escapeTable(entry.candidate_id)} | ${escapeTable(entry.verdict)} | ${escapeTable(entry.outcome)} | ${entry.pr_url ? `[PR](${entry.pr_url})` : "-"} | ${escapeTable(entry.notes)} |`,
          ),
        ].join("\n");
  const checked =
    normalized.last_checked_candidate_id && normalized.last_checked_at
      ? `_Last checked: ${normalized.last_checked_candidate_id} at ${normalized.last_checked_at}._`
      : "_Last checked: never._";
  return [
    "Central tracker for Claude upstream drift monitoring.",
    "",
    checked,
    "",
    "## Recent actionable candidates",
    "",
    table,
    "",
    "## Hidden state",
    "",
    "The workflow uses the Claude-specific hidden JSON block below for dedupe and retries.",
    "",
    serializeTrackerState(normalized),
    "",
  ].join("\n");
}

function normalizeState(value: unknown): ClaudeTrackerState {
  if (!isRecord(value)) return emptyTrackerState();
  const processed = Array.isArray(value.processed)
    ? value.processed
        .map(normalizeEntry)
        .filter((entry): entry is ClaudeTrackerEntry => entry !== null)
        .filter(
          (entry, index, all) =>
            all.findIndex(
              (candidate) => candidate.candidate_id === entry.candidate_id,
            ) === index,
        )
        .slice(0, TRACKER_HISTORY_LIMIT)
    : [];
  return {
    last_checked_candidate_id:
      typeof value.last_checked_candidate_id === "string"
        ? value.last_checked_candidate_id
        : null,
    last_checked_at:
      typeof value.last_checked_at === "string" ? value.last_checked_at : null,
    processed,
  };
}

function normalizeEntry(value: unknown): ClaudeTrackerEntry | null {
  if (
    !isRecord(value) ||
    typeof value.candidate_id !== "string" ||
    typeof value.package_digest !== "string" ||
    typeof value.docs_digest !== "string" ||
    !(
      typeof value.runtime_digest === "string" || value.runtime_digest === null
    ) ||
    !isVerdict(value.verdict) ||
    !isOutcome(value.outcome) ||
    !(typeof value.pr_url === "string" || value.pr_url === null) ||
    typeof value.notes !== "string" ||
    typeof value.processed_at !== "string" ||
    typeof value.workflow_run_url !== "string" ||
    !(
      typeof value.state_commit_sha === "string" ||
      value.state_commit_sha === null
    )
  ) {
    return null;
  }
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.filter(isAttempt).slice(0, TRACKER_ATTEMPT_HISTORY_LIMIT)
    : [];
  const errors = Array.isArray(value.errors)
    ? value.errors.filter(isError).slice(0, TRACKER_ERROR_HISTORY_LIMIT)
    : [];
  return { ...value, attempts, errors } as ClaudeTrackerEntry;
}

function isAttempt(value: unknown): value is ClaudeTrackerAttempt {
  return (
    isRecord(value) &&
    typeof value.attempted_at === "string" &&
    typeof value.workflow_run_url === "string" &&
    isOutcome(value.outcome) &&
    (typeof value.error === "string" || value.error === null)
  );
}

function isError(value: unknown): value is ClaudeTrackerError {
  return (
    isRecord(value) &&
    typeof value.occurred_at === "string" &&
    typeof value.workflow_run_url === "string" &&
    typeof value.message === "string"
  );
}

function isVerdict(value: unknown): value is ClaudeWatchVerdict {
  return (
    value === "no-op" ||
    value === "prompt review needed" ||
    value === "tool contract review needed" ||
    value === "tool surface review needed" ||
    value === "harness behavior review needed" ||
    value === "manual review required"
  );
}

function isOutcome(value: unknown): value is ClaudeWatchOutcome {
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

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
