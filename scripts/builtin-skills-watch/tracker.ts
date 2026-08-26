import type { BuiltinSkillWatchAnalysis } from "./analysis.ts";
import {
  digestReviewEvidence,
  parseReviewEvidence,
  type ReviewEvidence,
} from "./evidence.ts";

const STATE_START = "<!-- builtin-skills-agent-watch-state";
const STATE_END = "-->";
const HISTORY_LIMIT = 10;
const VISIBLE_HISTORY_LIMIT = 10;
const MAX_TRACKER_BODY_BYTES = 60_000;

export type TerminalOutcome = "no_drift" | "pr_created" | "needs_human_review";
export type TrackerOutcome = TerminalOutcome | "error";

export interface SkillAudit {
  candidate_id: string;
  audited_sha: string;
  skill_digest: string;
  outcome: TerminalOutcome;
  pr_url: string | null;
  notes: string;
  audited_at: string;
  workflow_run_url: string;
  evidence_digest: string;
  evidence: ReviewEvidence;
}

export interface TrackerEntry {
  candidate_id: string;
  skill: string;
  current_sha: string;
  skill_digest: string;
  outcome: TrackerOutcome;
  pr_url: string | null;
  notes: string;
  processed_at: string;
  workflow_run_url: string;
  evidence_digest: string | null;
  evidence: ReviewEvidence | null;
}

export interface PendingCandidate {
  candidate_id: string;
  skill: string;
  current_sha: string;
  skill_digest: string;
  audit_at: string;
  previous_audit: BuiltinSkillWatchAnalysis["previous_audit"];
  workflow_run_url: string;
}

export interface TrackerState {
  schema_version: 1;
  last_attempted_skill: string | null;
  last_attempted_at: string | null;
  pending: PendingCandidate | null;
  skills: Record<string, SkillAudit>;
  history: TrackerEntry[];
}

export interface RecordOutcomeOptions {
  analysis: BuiltinSkillWatchAnalysis;
  outcome: TrackerOutcome;
  notes: string;
  prUrl?: string | null;
  processedAt?: string;
  evidence?: ReviewEvidence | null;
}

export function emptyTrackerState(): TrackerState {
  return {
    schema_version: 1,
    last_attempted_skill: null,
    last_attempted_at: null,
    pending: null,
    skills: {},
    history: [],
  };
}

export function startCandidate(
  state: TrackerState,
  analysis: BuiltinSkillWatchAnalysis,
): TrackerState {
  if (state.pending) {
    if (state.pending.candidate_id === analysis.candidate_id) return state;
    throw new Error(
      `Cannot start ${analysis.candidate_id}; ${state.pending.candidate_id} is pending`,
    );
  }
  return {
    ...state,
    pending: {
      candidate_id: analysis.candidate_id,
      skill: analysis.skill,
      current_sha: analysis.current_sha,
      skill_digest: analysis.skill_digest,
      audit_at: analysis.audit_at,
      previous_audit: analysis.previous_audit,
      workflow_run_url: analysis.workflow_run_url,
    },
  };
}

export function parseTrackerState(body: string): TrackerState {
  const start = body.indexOf(STATE_START);
  if (start === -1) {
    throw new Error("Built-in skills tracker hidden state is missing");
  }
  const jsonStart = start + STATE_START.length;
  const end = body.indexOf(STATE_END, jsonStart);
  if (end === -1) {
    throw new Error("Built-in skills tracker hidden state is incomplete");
  }
  try {
    return normalizeState(JSON.parse(body.slice(jsonStart, end).trim()));
  } catch (error) {
    throw new Error("Built-in skills tracker hidden state is invalid", {
      cause: error,
    });
  }
}

export function recordOutcome(
  state: TrackerState,
  options: RecordOutcomeOptions,
): TrackerState {
  if (options.notes.length > 200) {
    throw new Error("Tracker notes must be at most 200 characters");
  }
  const existingOutcome = terminalOutcomeForCandidate(
    state,
    options.analysis.candidate_id,
  );
  if (existingOutcome) {
    if (options.outcome === "error" || options.outcome === existingOutcome) {
      return state;
    }
    throw new Error(
      `Candidate ${options.analysis.candidate_id} already has terminal outcome ${existingOutcome}`,
    );
  }
  assertPendingCandidate(state.pending, options.analysis);
  if (isTerminalOutcome(options.outcome) && !options.evidence) {
    throw new Error("Terminal skill audits require structured evidence");
  }
  const evidenceDigest = options.evidence
    ? digestReviewEvidence(options.evidence)
    : null;
  const processedAt = options.processedAt ?? new Date().toISOString();
  const entry: TrackerEntry = {
    candidate_id: options.analysis.candidate_id,
    skill: options.analysis.skill,
    current_sha: options.analysis.current_sha,
    skill_digest: options.analysis.skill_digest,
    outcome: options.outcome,
    pr_url: options.prUrl ?? null,
    notes: options.notes,
    processed_at: processedAt,
    workflow_run_url: options.analysis.workflow_run_url,
    evidence_digest: evidenceDigest,
    evidence: options.evidence ?? null,
  };
  const history = [
    entry,
    ...state.history.filter(
      (candidate) => candidate.candidate_id !== entry.candidate_id,
    ),
  ].slice(0, HISTORY_LIMIT);
  const skills = { ...state.skills };
  if (isTerminalOutcome(options.outcome)) {
    skills[options.analysis.skill] = {
      candidate_id: options.analysis.candidate_id,
      audited_sha: options.analysis.current_sha,
      skill_digest: options.analysis.skill_digest,
      outcome: options.outcome,
      pr_url: options.prUrl ?? null,
      notes: options.notes,
      audited_at: processedAt,
      workflow_run_url: options.analysis.workflow_run_url,
      evidence_digest: evidenceDigest as string,
      evidence: options.evidence as ReviewEvidence,
    };
  }
  return {
    schema_version: 1,
    last_attempted_skill: options.analysis.skill,
    last_attempted_at: processedAt,
    pending: isTerminalOutcome(options.outcome) ? null : state.pending,
    skills,
    history,
  };
}

export function hasTerminalCandidate(
  state: TrackerState,
  candidateId: string,
): boolean {
  return terminalOutcomeForCandidate(state, candidateId) !== null;
}

export function isTerminalOutcome(
  outcome: TrackerOutcome,
): outcome is TerminalOutcome {
  return outcome !== "error";
}

function terminalOutcomeForCandidate(
  state: TrackerState,
  candidateId: string,
): TerminalOutcome | null {
  const historyEntry = state.history.find(
    (entry) =>
      entry.candidate_id === candidateId && isTerminalOutcome(entry.outcome),
  );
  if (historyEntry && isTerminalOutcome(historyEntry.outcome)) {
    return historyEntry.outcome;
  }
  const skillAudit = Object.values(state.skills).find(
    (audit) => audit.candidate_id === candidateId,
  );
  return skillAudit?.outcome ?? null;
}

export function renderTrackerBody(
  state: TrackerState,
  inventory: string[] = Object.keys(state.skills),
): string {
  const normalized = normalizeState(state);
  const lines = [
    "Central tracker for Amelia-driven built-in skill staleness reviews.",
    "",
    renderLastAttempt(normalized),
    "",
    "## Skills",
    "",
    renderSkillsTable(normalized, inventory),
    "",
    "## Recent actionable reviews",
    "",
    renderActionableHistory(normalized),
    "",
    "## Hidden state",
    "",
    "The workflow uses the hidden JSON block below for rotation, deduplication, and retries.",
    "",
    serializeTrackerState(normalized),
  ];
  const body = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_TRACKER_BODY_BYTES) {
    throw new Error("Built-in skills tracker body exceeds 60000 bytes");
  }
  return body;
}

export function serializeTrackerState(state: TrackerState): string {
  return `${STATE_START}\n${JSON.stringify(normalizeState(state), null, 2)}\n${STATE_END}`;
}

function renderLastAttempt(state: TrackerState): string {
  if (!state.last_attempted_skill || !state.last_attempted_at) {
    return "_Last attempted: never._";
  }
  return `_Last attempted: ${state.last_attempted_skill} at ${state.last_attempted_at}._`;
}

function renderSkillsTable(state: TrackerState, inventory: string[]): string {
  const rows = [
    "| Skill | Last audit | Outcome | PR | Notes |",
    "|---|---|---|---|---|",
  ];
  for (const skill of [...inventory].sort()) {
    const audit = state.skills[skill];
    if (!audit) {
      rows.push(`| ${escapeTable(skill)} | never | - | - | - |`);
      continue;
    }
    rows.push(
      `| ${escapeTable(skill)} | ${escapeTable(audit.audited_at)} | ${escapeTable(audit.outcome)} | ${renderPr(audit.pr_url)} | ${escapeTable(audit.notes)} |`,
    );
  }
  return rows.join("\n");
}

function renderActionableHistory(state: TrackerState): string {
  const entries = state.history
    .filter((entry) => entry.outcome !== "no_drift")
    .slice(0, VISIBLE_HISTORY_LIMIT);
  if (entries.length === 0) return "_No actionable reviews recorded yet._";
  const rows = [
    "| Skill | Candidate | Outcome | PR | Notes |",
    "|---|---|---|---|---|",
  ];
  for (const entry of entries) {
    rows.push(
      `| ${escapeTable(entry.skill)} | \`${escapeTable(entry.candidate_id)}\` | ${escapeTable(entry.outcome)} | ${renderPr(entry.pr_url)} | ${escapeTable(entry.notes)} |`,
    );
  }
  return rows.join("\n");
}

function renderPr(prUrl: string | null): string {
  return prUrl ? `[PR](${prUrl})` : "-";
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function normalizeState(value: unknown): TrackerState {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new TypeError("tracker state must use schema version 1");
  }
  if (!isNullableString(value.last_attempted_skill)) {
    throw new TypeError("tracker last_attempted_skill is invalid");
  }
  if (!isNullableString(value.last_attempted_at)) {
    throw new TypeError("tracker last_attempted_at is invalid");
  }
  if (
    value.last_attempted_at !== null &&
    !isIsoTimestamp(value.last_attempted_at)
  ) {
    throw new TypeError("tracker last_attempted_at is not an ISO timestamp");
  }
  if (value.pending !== null && !isPendingCandidate(value.pending)) {
    throw new TypeError("tracker pending candidate is invalid");
  }
  if (!isRecord(value.skills)) {
    throw new TypeError("tracker skills are invalid");
  }
  if (!Array.isArray(value.history) || !value.history.every(isTrackerEntry)) {
    throw new TypeError("tracker history is invalid");
  }
  const skills: Record<string, SkillAudit> = {};
  for (const [skill, audit] of Object.entries(value.skills)) {
    if (
      !isSkillAudit(audit) ||
      audit.evidence.skill !== skill ||
      audit.evidence.candidate_id !== audit.candidate_id ||
      digestReviewEvidence(audit.evidence) !== audit.evidence_digest
    ) {
      throw new TypeError(`tracker audit for ${skill} is invalid`);
    }
    skills[skill] = audit;
  }
  return {
    schema_version: 1,
    last_attempted_skill: value.last_attempted_skill,
    last_attempted_at: value.last_attempted_at,
    pending: value.pending,
    skills,
    history: value.history.slice(0, HISTORY_LIMIT),
  };
}

function isSkillAudit(value: unknown): value is SkillAudit {
  return (
    isRecord(value) &&
    isCandidateId(value.candidate_id) &&
    isCommitSha(value.audited_sha) &&
    isDigest(value.skill_digest) &&
    isTerminalOutcomeValue(value.outcome) &&
    isNullableString(value.pr_url) &&
    typeof value.notes === "string" &&
    isIsoTimestamp(value.audited_at) &&
    isWorkflowRunUrl(value.workflow_run_url) &&
    isDigest(value.evidence_digest) &&
    isReviewEvidence(value.evidence)
  );
}

function isTrackerEntry(value: unknown): value is TrackerEntry {
  return (
    isRecord(value) &&
    isCandidateId(value.candidate_id) &&
    isSkillName(value.skill) &&
    isCommitSha(value.current_sha) &&
    isDigest(value.skill_digest) &&
    isTrackerOutcome(value.outcome) &&
    isNullableString(value.pr_url) &&
    typeof value.notes === "string" &&
    isIsoTimestamp(value.processed_at) &&
    isWorkflowRunUrl(value.workflow_run_url) &&
    (value.evidence_digest === null || isDigest(value.evidence_digest)) &&
    (value.outcome === "error"
      ? value.evidence_digest === null && value.evidence === null
      : isDigest(value.evidence_digest) &&
        isReviewEvidence(value.evidence) &&
        value.evidence.candidate_id === value.candidate_id &&
        value.evidence.skill === value.skill &&
        digestReviewEvidence(value.evidence) === value.evidence_digest)
  );
}

function isPendingCandidate(value: unknown): value is PendingCandidate {
  return (
    isRecord(value) &&
    isCandidateId(value.candidate_id) &&
    isSkillName(value.skill) &&
    isCommitSha(value.current_sha) &&
    isDigest(value.skill_digest) &&
    isIsoTimestamp(value.audit_at) &&
    (value.previous_audit === null || isPriorAudit(value.previous_audit)) &&
    isWorkflowRunUrl(value.workflow_run_url)
  );
}

function isPriorAudit(
  value: unknown,
): value is BuiltinSkillWatchAnalysis["previous_audit"] {
  return (
    isRecord(value) &&
    isCandidateId(value.candidate_id) &&
    isCommitSha(value.audited_sha) &&
    isDigest(value.skill_digest) &&
    isIsoTimestamp(value.audited_at)
  );
}

function assertPendingCandidate(
  pending: PendingCandidate | null,
  analysis: BuiltinSkillWatchAnalysis,
): void {
  if (!pending || pending.candidate_id !== analysis.candidate_id) {
    throw new Error(`Candidate ${analysis.candidate_id} is not pending`);
  }
  if (
    pending.skill !== analysis.skill ||
    pending.current_sha !== analysis.current_sha ||
    pending.skill_digest !== analysis.skill_digest ||
    pending.audit_at !== analysis.audit_at
  ) {
    throw new Error(
      `Pending candidate ${analysis.candidate_id} does not match analysis`,
    );
  }
}

function isReviewEvidence(value: unknown): value is ReviewEvidence {
  try {
    parseReviewEvidence(value);
    return true;
  } catch {
    return false;
  }
}

function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isCandidateId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*@[a-f0-9]{12}-[a-f0-9]{16}$/.test(value)
  );
}

function isSkillName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isWorkflowRunUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^https:\/\/github\.com\/letta-ai\/letta-code\/actions\/runs\/\d+$/.test(
      value,
    )
  );
}

function isTrackerOutcome(value: unknown): value is TrackerOutcome {
  return value === "error" || isTerminalOutcomeValue(value);
}

function isTerminalOutcomeValue(value: unknown): value is TerminalOutcome {
  return (
    value === "no_drift" ||
    value === "pr_created" ||
    value === "needs_human_review"
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
