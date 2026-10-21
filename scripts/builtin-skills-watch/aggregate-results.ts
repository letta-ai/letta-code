#!/usr/bin/env bun
/** Validates a daily skill-review batch and updates the tracker once. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BuiltinSkillWatchAnalysis,
  buildAnalysis,
  DEFAULT_TARGET_REPO,
} from "./analysis.ts";
import { createIssueComment, editIssueBody } from "./github.ts";
import {
  discoverReviewArtifacts,
  formatFailureReceipt,
} from "./result-artifacts.ts";
import {
  hasTerminalCandidate,
  parseTrackerState,
  recordOutcome,
  renderTrackerBody,
} from "./tracker.ts";
import {
  assertAnalysisIdentity,
  getOpenTrackerIssue,
  type ReviewResult,
  readAnalysis,
  readReviewResult,
  verifyPullRequest,
} from "./update-tracker.ts";

interface Args {
  repo: string;
  trackerIssue: number | null;
  manifestFile: string | null;
  analysisDir: string | null;
  resultsDir: string | null;
  expectedGithubLogin: string | null;
  dryRun: boolean;
}

interface Manifest {
  schema_version: 1;
  tracker_issue: number;
  inventory: string[];
  candidates: Array<{ skill: string; candidate_id: string }>;
}

export interface ValidatedOutcome {
  analysis: BuiltinSkillWatchAnalysis;
  result: ReviewResult | null;
}

export interface EvidenceCommentBatch {
  candidateIds: string[];
  body: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: DEFAULT_TARGET_REPO,
    trackerIssue: null,
    manifestFile: null,
    analysisDir: null,
    resultsDir: null,
    expectedGithubLogin: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") args.repo = argv[++index] ?? args.repo;
    else if (arg === "--tracker-issue") {
      args.trackerIssue = Number(argv[++index]);
    } else if (arg === "--manifest-file") {
      args.manifestFile = argv[++index] ?? null;
    } else if (arg === "--analysis-dir") {
      args.analysisDir = argv[++index] ?? null;
    } else if (arg === "--results-dir") {
      args.resultsDir = argv[++index] ?? null;
    } else if (arg === "--expected-github-login") {
      args.expectedGithubLogin = argv[++index] ?? null;
    } else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.trackerIssue || Number.isNaN(args.trackerIssue)) {
    throw new Error("--tracker-issue is required");
  }
  if (
    !args.manifestFile ||
    !args.analysisDir ||
    !args.resultsDir ||
    !args.expectedGithubLogin
  ) {
    throw new Error(
      "--manifest-file, --analysis-dir, --results-dir, and --expected-github-login are required",
    );
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const manifest = readManifest(args.manifestFile as string);
  if (manifest.tracker_issue !== args.trackerIssue) {
    throw new Error("Manifest tracker issue does not match the workflow input");
  }
  const original = getOpenTrackerIssue(args.repo, args.trackerIssue as number);
  let state = parseTrackerState(original.body);
  let failed = false;
  const outcomes: ValidatedOutcome[] = [];
  const artifacts = discoverReviewArtifacts(args.resultsDir as string);

  for (const candidate of manifest.candidates) {
    const analysisPath = join(
      args.analysisDir as string,
      `${candidate.skill}.json`,
    );
    const received = readAnalysis(analysisPath);
    if (
      received.candidate_id !== candidate.candidate_id ||
      received.skill !== candidate.skill
    ) {
      throw new Error(`Manifest entry for ${candidate.skill} is invalid`);
    }
    if (hasTerminalCandidate(state, received.candidate_id)) continue;
    const pending = state.pending[received.skill];
    if (!pending || pending.candidate_id !== received.candidate_id) {
      throw new Error(`Candidate ${received.candidate_id} is not pending`);
    }
    const analysis = buildAnalysis({
      skill: received.skill,
      currentSha: pending.current_sha,
      auditAt: pending.audit_at,
      previousAudit: previousAudit(state, received.skill),
    });
    analysis.workflow_run_url = workflowRunUrl(pending.workflow_run_id);
    assertAnalysisIdentity(received, analysis);

    const resultPath = artifacts.results.get(received.candidate_id);
    try {
      if (!resultPath) {
        const receipt = artifacts.failures.get(received.candidate_id);
        if (receipt) throw new Error(formatFailureReceipt(receipt));
        throw new Error(
          `Amelia result artifact is missing for ${received.candidate_id}`,
        );
      }
      const result = readReviewResult(resultPath, analysis);
      if (result.pr_url) {
        verifyPullRequest(
          args.repo,
          result.pr_url,
          analysis,
          args.expectedGithubLogin as string,
        );
      }
      outcomes.push({ analysis, result });
    } catch (error) {
      failed = true;
      console.error(`${received.skill}: ${errorMessage(error)}`);
      outcomes.push({ analysis, result: null });
    }
  }

  assertTrackerUnchanged(args, original.body);
  const evidenceUrls = args.dryRun
    ? dryRunEvidenceUrls(outcomes, args.trackerIssue as number)
    : postEvidenceComments(args.repo, args.trackerIssue as number, outcomes);
  for (const outcome of outcomes) {
    if (outcome.result) {
      state = recordOutcome(state, {
        analysis: outcome.analysis,
        outcome: outcome.result.outcome,
        notes: outcome.result.notes,
        prUrl: outcome.result.pr_url,
        evidence: outcome.result.evidence,
        evidenceUrl: evidenceUrls.get(outcome.analysis.candidate_id),
      });
    } else {
      state = recordOutcome(state, {
        analysis: outcome.analysis,
        outcome: "error",
        notes: "Amelia review failed before a valid result; retry this skill",
      });
    }
  }

  const nextBody = renderTrackerBody(state, manifest.inventory);
  if (args.dryRun) console.log(nextBody);
  else {
    assertTrackerUnchanged(args, original.body);
    editIssueBody(args.repo, args.trackerIssue as number, nextBody);
  }
  if (failed) process.exit(1);
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

function assertTrackerUnchanged(args: Args, expectedBody: string): void {
  const latest = getOpenTrackerIssue(args.repo, args.trackerIssue as number);
  if (latest.body !== expectedBody) {
    throw new Error("Tracker body changed while results were being validated");
  }
}

function postEvidenceComments(
  repo: string,
  issueNumber: number,
  outcomes: ValidatedOutcome[],
): Map<string, string> {
  const urls = new Map<string, string>();
  for (const batch of buildEvidenceCommentBatches(outcomes)) {
    const url = createIssueComment(repo, issueNumber, batch.body);
    for (const candidateId of batch.candidateIds) urls.set(candidateId, url);
  }
  return urls;
}

export function buildEvidenceCommentBatches(
  outcomes: ValidatedOutcome[],
): EvidenceCommentBatch[] {
  const batches: EvidenceCommentBatch[] = [];
  let blocks: Array<{ candidateId: string; text: string }> = [];
  let bytes = 0;
  const flush = (): void => {
    if (blocks.length === 0) return;
    const body = [
      "## Built-in skill audit evidence",
      "",
      ...blocks.map((block) => block.text),
    ].join("\n");
    batches.push({
      candidateIds: blocks.map((block) => block.candidateId),
      body,
    });
    blocks = [];
    bytes = 0;
  };
  for (const outcome of terminalOutcomes(outcomes)) {
    const block = renderEvidenceBlock(outcome.analysis, outcome.result);
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (bytes + blockBytes > 60_000) flush();
    blocks.push({ candidateId: outcome.analysis.candidate_id, text: block });
    bytes += blockBytes;
  }
  flush();
  return batches;
}

function dryRunEvidenceUrls(
  outcomes: ValidatedOutcome[],
  issueNumber: number,
): Map<string, string> {
  return new Map(
    terminalOutcomes(outcomes).map((outcome) => [
      outcome.analysis.candidate_id,
      `https://github.com/letta-ai/letta-code/issues/${issueNumber}#issuecomment-1`,
    ]),
  );
}

function terminalOutcomes(
  outcomes: ValidatedOutcome[],
): Array<ValidatedOutcome & { result: ReviewResult }> {
  return outcomes.filter(
    (outcome): outcome is ValidatedOutcome & { result: ReviewResult } =>
      outcome.result !== null,
  );
}

function renderEvidenceBlock(
  analysis: BuiltinSkillWatchAnalysis,
  result: ReviewResult,
): string {
  return [
    `<details><summary>${analysis.skill}: ${result.outcome}</summary>`,
    "",
    `Candidate: \`${analysis.candidate_id}\``,
    `Outcome: \`${result.outcome}\``,
    `Notes: ${result.notes}`,
    `PR: ${result.pr_url ?? "-"}`,
    "",
    "```json",
    JSON.stringify(result.evidence, null, 2),
    "```",
    "",
    "</details>",
    "",
  ].join("\n");
}

function readManifest(path: string): Manifest {
  const value = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (
    value.schema_version !== 1 ||
    !Number.isInteger(value.tracker_issue) ||
    !Array.isArray(value.inventory) ||
    !Array.isArray(value.candidates) ||
    value.candidates.some(
      (candidate) =>
        typeof candidate.skill !== "string" ||
        typeof candidate.candidate_id !== "string" ||
        !value.inventory.includes(candidate.skill),
    )
  ) {
    throw new Error("Built-in skill watch manifest is invalid");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) main();
