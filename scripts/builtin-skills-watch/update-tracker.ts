#!/usr/bin/env bun
/** Records or verifies one built-in skill review outcome. */

import { readFileSync } from "node:fs";
import {
  type BuiltinSkillWatchAnalysis,
  buildAnalysis,
  DEFAULT_TARGET_REPO,
} from "./analysis.ts";
import { parseReviewEvidence, type ReviewEvidence } from "./evidence.ts";
import { createIssueComment, editIssueBody, ghJson } from "./github.ts";
import {
  hasTerminalCandidate,
  parseTrackerState,
  recordOutcome,
  renderTrackerBody,
  type TrackerOutcome,
} from "./tracker.ts";

interface Args {
  repo: string;
  trackerIssue: number | null;
  analysisFile: string | null;
  resultFile: string | null;
  candidateId: string | null;
  outcome: TrackerOutcome | null;
  notes: string;
  expectedGithubLogin: string | null;
  assertTerminal: boolean;
  dryRun: boolean;
}

export interface PullRequestView {
  author: { login: string };
  baseRefName: string;
  body: string;
  files: Array<{ path: string }>;
  headRefOid: string;
  isDraft: boolean;
  mergedAt?: string | null;
  state: string;
  url: string;
}

export interface TrackerIssueView {
  author: { login: string };
  body: string | null;
  labels: Array<{ name: string }>;
  state: string;
  title: string;
}

export interface ReviewResult {
  schema_version: 1;
  candidate_id: string;
  skill: string;
  outcome: "no_drift" | "pr_created" | "needs_human_review";
  notes: string;
  pr_url: string | null;
  evidence: ReviewEvidence;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: DEFAULT_TARGET_REPO,
    trackerIssue: null,
    analysisFile: null,
    resultFile: null,
    candidateId: null,
    outcome: null,
    notes: "",
    expectedGithubLogin: null,
    assertTerminal: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") args.repo = argv[++index] ?? args.repo;
    else if (arg === "--tracker-issue") {
      args.trackerIssue = Number(argv[++index]);
    } else if (arg === "--analysis-file") {
      args.analysisFile = argv[++index] ?? null;
    } else if (arg === "--result-file") {
      args.resultFile = argv[++index] ?? null;
    } else if (arg === "--candidate-id") {
      args.candidateId = argv[++index] ?? null;
    } else if (arg === "--outcome") {
      args.outcome = parseOutcome(argv[++index]);
    } else if (arg === "--notes") args.notes = argv[++index] ?? "";
    else if (arg === "--expected-github-login") {
      args.expectedGithubLogin = argv[++index] ?? null;
    } else if (arg === "--assert-terminal") args.assertTerminal = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/builtin-skills-watch/update-tracker.ts --tracker-issue ISSUE (--candidate-id ID --assert-terminal | --analysis-file FILE (--result-file FILE --expected-github-login LOGIN | --outcome error [--notes TEXT])) [--repo OWNER/REPO] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.trackerIssue || Number.isNaN(args.trackerIssue)) {
    throw new Error("--tracker-issue is required");
  }
  if (args.assertTerminal) {
    if (!args.candidateId) {
      throw new Error("--candidate-id is required with --assert-terminal");
    }
    return args;
  }
  if (!args.analysisFile) throw new Error("--analysis-file is required");
  if (args.resultFile) {
    if (!args.expectedGithubLogin) {
      throw new Error("--expected-github-login is required with --result-file");
    }
  } else if (args.outcome !== "error") {
    throw new Error(
      "Use --result-file for terminal outcomes or --outcome error",
    );
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tracker = getOpenTrackerIssue(args.repo, args.trackerIssue as number);
  const state = parseTrackerState(tracker.body);

  if (args.assertTerminal) {
    if (!hasTerminalCandidate(state, args.candidateId as string)) {
      throw new Error(
        `Tracker has no terminal outcome for ${args.candidateId}`,
      );
    }
    console.log(`Tracker recorded terminal outcome for ${args.candidateId}`);
    return;
  }

  const receivedAnalysis = readAnalysis(args.analysisFile as string);
  if (hasTerminalCandidate(state, receivedAnalysis.candidate_id)) {
    console.log(
      `Tracker already recorded terminal outcome for ${receivedAnalysis.candidate_id}`,
    );
    return;
  }
  const pending = state.pending[receivedAnalysis.skill];
  if (!pending || pending.candidate_id !== receivedAnalysis.candidate_id) {
    throw new Error(
      `Candidate ${receivedAnalysis.candidate_id} is not pending for ${receivedAnalysis.skill}`,
    );
  }
  const analysis = buildAnalysis({
    skill: receivedAnalysis.skill,
    currentSha: pending.current_sha,
    auditAt: pending.audit_at,
    previousAudit: previousAudit(state, receivedAnalysis.skill),
  });
  analysis.workflow_run_url = workflowRunUrl(pending.workflow_run_id);
  assertAnalysisIdentity(receivedAnalysis, analysis);
  const result = args.resultFile
    ? readReviewResult(args.resultFile, analysis)
    : {
        outcome: "error" as const,
        notes: args.notes || defaultNotes("error"),
        pr_url: null,
        evidence: null,
      };
  if (result.pr_url) {
    verifyPullRequest(
      args.repo,
      result.pr_url,
      analysis,
      args.expectedGithubLogin as string,
    );
  }
  const evidenceUrl = result.evidence
    ? args.dryRun
      ? `https://github.com/letta-ai/letta-code/issues/${args.trackerIssue}#issuecomment-1`
      : createIssueComment(
          args.repo,
          args.trackerIssue as number,
          renderEvidenceComment(analysis, result),
        )
    : null;
  const next = recordOutcome(state, {
    analysis,
    outcome: result.outcome,
    notes: result.notes,
    prUrl: result.pr_url,
    evidence: result.evidence,
    evidenceUrl,
  });
  const inventory = [
    ...new Set([
      ...analysis.skill_inventory,
      ...Object.keys(next.skills),
      ...Object.keys(next.pending),
    ]),
  ].sort();
  const nextBody = renderTrackerBody(next, inventory);
  if (args.dryRun) console.log(nextBody);
  else {
    editIssueBody(args.repo, args.trackerIssue as number, nextBody);
    console.log(
      `Recorded ${analysis.candidate_id} as ${result.outcome} in #${args.trackerIssue}`,
    );
  }
}

function previousAudit(
  state: ReturnType<typeof parseTrackerState>,
  skill: string,
): BuiltinSkillWatchAnalysis["previous_audit"] {
  const audit = state.skills[skill];
  return audit
    ? {
        candidate_id: audit.candidate_id,
        audited_sha: audit.audited_sha,
        skill_digest: audit.skill_digest,
        audited_at: audit.audited_at,
      }
    : null;
}

function workflowRunUrl(runId: string): string {
  return `https://github.com/letta-ai/letta-code/actions/runs/${runId}`;
}

function renderEvidenceComment(
  analysis: BuiltinSkillWatchAnalysis,
  result: ReviewResult,
): string {
  return [
    `## Built-in skill audit evidence: ${analysis.skill}`,
    "",
    `Candidate: \`${analysis.candidate_id}\``,
    `Outcome: \`${result.outcome}\``,
    `Notes: ${result.notes}`,
    `PR: ${result.pr_url ?? "-"}`,
    "",
    "```json",
    JSON.stringify(result.evidence, null, 2),
    "```",
  ].join("\n");
}

export function getOpenTrackerIssue(
  repo: string,
  issueNumber: number,
): { body: string } {
  const issue = ghJson<TrackerIssueView>([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    repo,
    "--json",
    "author,body,labels,state,title",
  ]);
  validateTrackerIssueView(issue);
  return { body: issue.body ?? "" };
}

export function validateTrackerIssueView(issue: TrackerIssueView): void {
  if (
    issue.state !== "OPEN" ||
    issue.title !== "Built-in skill staleness tracker" ||
    !issue.labels.some((label) => label.name === "builtin-skills-watch") ||
    (issue.author.login !== "app/github-actions" &&
      issue.author.login !== "github-actions[bot]")
  ) {
    throw new Error("Built-in skills tracker issue is closed or invalid");
  }
}

export function readAnalysis(path: string): BuiltinSkillWatchAnalysis {
  const analysis = JSON.parse(
    readFileSync(path, "utf8"),
  ) as BuiltinSkillWatchAnalysis;
  if (
    analysis.schema_version !== 1 ||
    typeof analysis.candidate_id !== "string" ||
    typeof analysis.skill !== "string" ||
    !Array.isArray(analysis.skill_inventory) ||
    !analysis.skill_inventory.includes(analysis.skill)
  ) {
    throw new Error("Built-in skill analysis is invalid");
  }
  return analysis;
}

export function assertAnalysisIdentity(
  received: BuiltinSkillWatchAnalysis,
  rebuilt: BuiltinSkillWatchAnalysis,
): void {
  const fields: Array<keyof BuiltinSkillWatchAnalysis> = [
    "candidate_id",
    "skill",
    "skill_path",
    "skill_files",
    "skill_digest",
    "current_sha",
    "audit_at",
    "previous_audit",
    "repository_changes",
    "skill_inventory",
  ];
  for (const field of fields) {
    if (JSON.stringify(received[field]) !== JSON.stringify(rebuilt[field])) {
      throw new Error(
        `Analysis field ${field} does not match the pending candidate`,
      );
    }
  }
}

export function readReviewResult(
  path: string,
  analysis: BuiltinSkillWatchAnalysis,
): ReviewResult {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseReviewResult(value, analysis);
}

export function parseReviewResult(
  value: unknown,
  analysis: BuiltinSkillWatchAnalysis,
): ReviewResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema_version",
      "candidate_id",
      "skill",
      "outcome",
      "notes",
      "pr_url",
      "evidence",
    ])
  ) {
    throw new Error("Review result has unknown or missing fields");
  }
  if (value.schema_version !== 1) {
    throw new Error("Review result must use schema version 1");
  }
  if (
    value.candidate_id !== analysis.candidate_id ||
    value.skill !== analysis.skill
  ) {
    throw new Error("Review result does not match the pending candidate");
  }
  if (
    value.outcome !== "no_drift" &&
    value.outcome !== "pr_created" &&
    value.outcome !== "needs_human_review"
  ) {
    throw new Error("Review result outcome is invalid");
  }
  if (
    typeof value.notes !== "string" ||
    value.notes.length === 0 ||
    value.notes.length > 120
  ) {
    throw new Error("Review result notes must contain 1 to 120 characters");
  }
  if (value.pr_url !== null && typeof value.pr_url !== "string") {
    throw new Error("Review result pr_url must be a string or null");
  }
  if (
    (value.outcome === "pr_created") !==
    (typeof value.pr_url === "string" && value.pr_url.length > 0)
  ) {
    throw new Error("Review result PR URL does not match its outcome");
  }
  const evidence = parseReviewEvidence(value.evidence);
  if (
    evidence.candidate_id !== analysis.candidate_id ||
    evidence.skill !== analysis.skill
  ) {
    throw new Error("Review evidence does not match the pending candidate");
  }
  return {
    schema_version: 1,
    candidate_id: value.candidate_id as string,
    skill: value.skill as string,
    outcome: value.outcome,
    notes: value.notes,
    pr_url: value.pr_url,
    evidence,
  };
}

export function verifyPullRequest(
  repo: string,
  prUrl: string,
  analysis: BuiltinSkillWatchAnalysis,
  expectedGithubLogin: string,
): void {
  verifyPullRequestIdentity(expectedGithubLogin);
  const pullRequest = getPullRequest(repo, prUrl);
  validatePullRequestView(pullRequest, prUrl, analysis, expectedGithubLogin);
  verifyPullRequestAncestry(repo, pullRequest, analysis);
}

export function verifyReconciledPullRequest(
  repo: string,
  prUrl: string,
  analysis: BuiltinSkillWatchAnalysis,
  expectedGithubLogin: string,
): void {
  verifyPullRequestIdentity(expectedGithubLogin);
  const pullRequest = getPullRequest(repo, prUrl);
  validateReconciledPullRequestView(
    pullRequest,
    prUrl,
    analysis,
    expectedGithubLogin,
  );
  verifyPullRequestAncestry(repo, pullRequest, analysis);
}

function verifyPullRequestIdentity(expectedGithubLogin: string): void {
  const authenticatedLogin = ghJson<{ login: string }>(["api", "user"]).login;
  if (authenticatedLogin !== expectedGithubLogin) {
    throw new Error(
      `Authenticated GitHub login ${authenticatedLogin} does not match ${expectedGithubLogin}`,
    );
  }
}

function getPullRequest(repo: string, prUrl: string): PullRequestView {
  const match = prUrl.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/,
  );
  if (!match || match[1] !== repo) {
    throw new Error(`PR URL must belong to https://github.com/${repo}`);
  }
  return ghJson<PullRequestView>([
    "pr",
    "view",
    match[2] as string,
    "--repo",
    repo,
    "--json",
    "author,baseRefName,body,files,headRefOid,isDraft,mergedAt,state,url",
  ]);
}

function verifyPullRequestAncestry(
  repo: string,
  pullRequest: PullRequestView,
  analysis: BuiltinSkillWatchAnalysis,
): void {
  const comparison = ghJson<{
    status: string;
    merge_base_commit: { sha: string };
  }>([
    "api",
    `repos/${repo}/compare/${analysis.current_sha}...${pullRequest.headRefOid}`,
  ]);
  if (
    comparison.status !== "ahead" ||
    comparison.merge_base_commit.sha !== analysis.current_sha
  ) {
    throw new Error("Watcher PR head is not based on the audited commit");
  }
}

export function validatePullRequestView(
  pullRequest: PullRequestView,
  prUrl: string,
  analysis: BuiltinSkillWatchAnalysis,
  expectedGithubLogin: string,
): void {
  validatePullRequestScope(pullRequest, prUrl, analysis, expectedGithubLogin);
  if (pullRequest.state !== "OPEN" || !pullRequest.isDraft) {
    throw new Error("Watcher PR must be open and draft");
  }
}

export function validateReconciledPullRequestView(
  pullRequest: PullRequestView,
  prUrl: string,
  analysis: BuiltinSkillWatchAnalysis,
  expectedGithubLogin: string,
): void {
  validatePullRequestScope(pullRequest, prUrl, analysis, expectedGithubLogin);
  const isOpenDraft = pullRequest.state === "OPEN" && pullRequest.isDraft;
  const isMerged =
    pullRequest.state === "MERGED" && typeof pullRequest.mergedAt === "string";
  if (!isOpenDraft && !isMerged) {
    throw new Error("Reconciled watcher PR must be an open draft or merged");
  }
}

function validatePullRequestScope(
  pullRequest: PullRequestView,
  prUrl: string,
  analysis: BuiltinSkillWatchAnalysis,
  expectedGithubLogin: string,
): void {
  if (pullRequest.url !== prUrl.replace(/\/$/, "")) {
    throw new Error(`PR URL mismatch: ${pullRequest.url}`);
  }
  if (pullRequest.author.login !== expectedGithubLogin) {
    throw new Error(
      `PR author ${pullRequest.author.login} does not match ${expectedGithubLogin}`,
    );
  }
  if (pullRequest.baseRefName !== "main") {
    throw new Error("Watcher PR must target main");
  }
  if (!/^[a-f0-9]{40}$/.test(pullRequest.headRefOid)) {
    throw new Error("Watcher PR head commit is invalid");
  }
  if (
    !pullRequest.body.includes(`Builtin-skill-watch: ${analysis.candidate_id}`)
  ) {
    throw new Error(
      `PR body is missing Builtin-skill-watch: ${analysis.candidate_id}`,
    );
  }
  const allowedTestPath = "src/agent/skills-discovery.test.ts";
  if (
    pullRequest.files.length === 0 ||
    !pullRequest.files.some((file) =>
      file.path.startsWith(`${analysis.skill_path}/`),
    ) ||
    pullRequest.files.some(
      (file) =>
        !file.path.startsWith(`${analysis.skill_path}/`) &&
        file.path !== allowedTestPath,
    )
  ) {
    throw new Error(
      "Watcher PR changed files outside the selected skill scope",
    );
  }
}

function parseOutcome(value: string | undefined): TrackerOutcome {
  if (
    value === "no_drift" ||
    value === "pr_created" ||
    value === "needs_human_review" ||
    value === "error"
  ) {
    return value;
  }
  throw new Error(`Unknown outcome: ${value}`);
}

function defaultNotes(outcome: TrackerOutcome): string {
  switch (outcome) {
    case "no_drift":
      return "reviewed against current sources; no skill change needed";
    case "pr_created":
      return "opened a focused skill update PR";
    case "needs_human_review":
      return "review needs a human decision";
    case "error":
      return "agent review failed before recording a terminal outcome";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

if (import.meta.main) main();
