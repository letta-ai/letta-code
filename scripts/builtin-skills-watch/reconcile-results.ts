#!/usr/bin/env bun
/** Reconciles pending tracker candidates against PR side effects before retries. */

import {
  type BuiltinSkillWatchAnalysis,
  buildAnalysis,
  DEFAULT_TARGET_REPO,
  listBuiltinSkillsAtCommit,
} from "./analysis.ts";
import type { ReviewEvidence } from "./evidence.ts";
import { createIssueComment, editIssueBody, ghJson, runGh } from "./github.ts";
import {
  parseTrackerState,
  recordOutcome,
  renderTrackerBody,
} from "./tracker.ts";
import {
  getOpenTrackerIssue,
  type PullRequestView,
  verifyReconciledPullRequest,
} from "./update-tracker.ts";

interface Args {
  repo: string;
  trackerIssue: number | null;
  expectedGithubLogin: string | null;
  dryRun: boolean;
}

export interface CandidatePullRequest extends PullRequestView {
  mergedAt: string | null;
  number: number;
}

export interface PullRequestReconciliation {
  canonical: CandidatePullRequest | null;
  duplicateOpen: CandidatePullRequest[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: DEFAULT_TARGET_REPO,
    trackerIssue: null,
    expectedGithubLogin: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") args.repo = argv[++index] ?? args.repo;
    else if (arg === "--tracker-issue") {
      args.trackerIssue = Number(argv[++index]);
    } else if (arg === "--expected-github-login") {
      args.expectedGithubLogin = argv[++index] ?? null;
    } else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/builtin-skills-watch/reconcile-results.ts --tracker-issue ISSUE --expected-github-login LOGIN [--repo OWNER/REPO] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.trackerIssue || Number.isNaN(args.trackerIssue)) {
    throw new Error("--tracker-issue is required");
  }
  if (!args.expectedGithubLogin) {
    throw new Error("--expected-github-login is required");
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  assertAuthenticatedLogin(args.expectedGithubLogin as string);
  const tracker = getOpenTrackerIssue(args.repo, args.trackerIssue as number);
  let state = parseTrackerState(tracker.body);
  const inventory = listBuiltinSkillsAtCommit("HEAD");
  let reconciled = 0;

  for (const skill of Object.keys(state.pending).sort()) {
    const pending = state.pending[skill];
    if (!pending) continue;
    const analysis = buildAnalysis({
      skill,
      currentSha: pending.current_sha,
      auditAt: pending.audit_at,
      previousAudit: previousAudit(state, skill),
    });
    analysis.workflow_run_url = workflowRunUrl(pending.workflow_run_id);
    const pullRequests = findCandidatePullRequests(
      args.repo,
      analysis.candidate_id,
    );
    const selected = selectCanonicalPullRequest(pullRequests);
    if (!selected.canonical) continue;

    verifyReconciledPullRequest(
      args.repo,
      selected.canonical.url,
      analysis,
      args.expectedGithubLogin as string,
    );
    for (const duplicate of selected.duplicateOpen) {
      verifyReconciledPullRequest(
        args.repo,
        duplicate.url,
        analysis,
        args.expectedGithubLogin as string,
      );
    }

    if (args.dryRun) {
      console.log(
        `${analysis.skill}: would reconcile ${selected.canonical.url}${renderDuplicatePlan(selected.duplicateOpen)}`,
      );
      continue;
    }

    for (const duplicate of selected.duplicateOpen) {
      closeDuplicatePullRequest(args.repo, duplicate, selected.canonical);
    }
    const evidence = reconciliationEvidence(analysis, selected.canonical);
    const evidenceUrl = createIssueComment(
      args.repo,
      args.trackerIssue as number,
      renderEvidenceComment(analysis, selected.canonical, evidence),
    );
    state = recordOutcome(state, {
      analysis,
      outcome: "pr_created",
      notes: reconciliationNotes(selected.canonical),
      prUrl: selected.canonical.url,
      evidence,
      evidenceUrl,
    });
    reconciled += 1;
  }

  if (args.dryRun) return;
  const latest = getOpenTrackerIssue(args.repo, args.trackerIssue as number);
  if (latest.body !== tracker.body) {
    throw new Error(
      "Tracker body changed while PR side effects were reconciled",
    );
  }
  if (reconciled > 0) {
    editIssueBody(
      args.repo,
      args.trackerIssue as number,
      renderTrackerBody(state, inventory),
    );
  }
  console.log(`Reconciled ${reconciled} pending built-in skill candidates`);
}

export function selectCanonicalPullRequest(
  pullRequests: CandidatePullRequest[],
): PullRequestReconciliation {
  const merged = pullRequests
    .filter((pullRequest) => pullRequest.state === "MERGED")
    .sort(byPullRequestNumber);
  if (merged.length > 1) {
    throw new Error(
      `Multiple merged watcher PRs found for one candidate: ${merged.map((pullRequest) => `#${pullRequest.number}`).join(", ")}`,
    );
  }
  const open = pullRequests
    .filter((pullRequest) => pullRequest.state === "OPEN")
    .sort(byPullRequestNumber);
  const canonical = merged[0] ?? open[0] ?? null;
  return {
    canonical,
    duplicateOpen: canonical
      ? open.filter((pullRequest) => pullRequest.number !== canonical.number)
      : [],
  };
}

function findCandidatePullRequests(
  repo: string,
  candidateId: string,
): CandidatePullRequest[] {
  const marker = `Builtin-skill-watch: ${candidateId}`;
  return ghJson<CandidatePullRequest[]>([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "all",
    "--search",
    `${marker} in:body`,
    "--limit",
    "20",
    "--json",
    "number,state,isDraft,mergedAt,author,baseRefName,headRefOid,body,files,url",
  ]).filter((pullRequest) => hasExactMarker(pullRequest.body, marker));
}

function assertAuthenticatedLogin(expectedGithubLogin: string): void {
  const authenticated = ghJson<{ login: string }>(["api", "user"]).login;
  if (authenticated !== expectedGithubLogin) {
    throw new Error(
      `Authenticated GitHub login ${authenticated} does not match ${expectedGithubLogin}`,
    );
  }
}

function closeDuplicatePullRequest(
  repo: string,
  duplicate: CandidatePullRequest,
  canonical: CandidatePullRequest,
): void {
  runGh([
    "pr",
    "close",
    String(duplicate.number),
    "--repo",
    repo,
    "--comment",
    `Closing as a duplicate of ${canonical.url}, which has the same exact built-in skill watcher candidate.`,
  ]);
}

function reconciliationEvidence(
  analysis: BuiltinSkillWatchAnalysis,
  pullRequest: CandidatePullRequest,
): ReviewEvidence {
  const status = pullRequest.state === "MERGED" ? "merged" : "open draft";
  return {
    schema_version: 1,
    candidate_id: analysis.candidate_id,
    skill: analysis.skill,
    sources: [
      {
        locator: pullRequest.url,
        revision: pullRequest.headRefOid,
        content_digest: null,
        retrieved_at: new Date().toISOString(),
        excerpt: `The ${status} watcher PR has the exact candidate marker and a validated skill-only diff.`,
        claims: [
          "the watcher already created and validated a PR for this exact candidate",
        ],
      },
    ],
    probes: [],
  };
}

function renderEvidenceComment(
  analysis: BuiltinSkillWatchAnalysis,
  pullRequest: CandidatePullRequest,
  evidence: ReviewEvidence,
): string {
  return [
    `## Reconciled built-in skill audit: ${analysis.skill}`,
    "",
    `Candidate: \`${analysis.candidate_id}\``,
    `PR: ${pullRequest.url}`,
    `PR state: \`${pullRequest.state.toLowerCase()}\``,
    "",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```",
  ].join("\n");
}

function reconciliationNotes(pullRequest: CandidatePullRequest): string {
  return pullRequest.state === "MERGED"
    ? `reconciled merged watcher PR #${pullRequest.number}`
    : `reconciled open draft watcher PR #${pullRequest.number}`;
}

function renderDuplicatePlan(duplicates: CandidatePullRequest[]): string {
  return duplicates.length === 0
    ? ""
    : ` and close duplicate ${duplicates.map((pullRequest) => `#${pullRequest.number}`).join(", ")}`;
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

function hasExactMarker(body: string, marker: string): boolean {
  return body.split(/\r?\n/).some((line) => line.trim() === marker);
}

function byPullRequestNumber(
  left: CandidatePullRequest,
  right: CandidatePullRequest,
): number {
  return left.number - right.number;
}

if (import.meta.main) main();
