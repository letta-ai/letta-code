#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { editIssueBody, getIssueBody, ghJson } from "./github.ts";
import {
  loadStateSnapshotAtCommit,
  resolveStateBranchTip,
} from "./state-branch.ts";
import {
  findTrackerEntry,
  hasProcessedCandidate,
  isTerminalOutcome,
  parseTrackerState,
  recordAnalysis,
  renderTrackerBody,
} from "./tracker.ts";
import type { ClaudeWatchAnalysis, ClaudeWatchOutcome } from "./types.ts";

const DEFAULT_REPO = "letta-ai/letta-code";

interface Args {
  repo: string;
  trackerIssue: number | null;
  analysisFile: string | null;
  candidateId: string | null;
  stateCommitSha: string | null;
  outcome: ClaudeWatchOutcome | null;
  notes: string;
  prUrl: string | null;
  assertTerminal: boolean;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: DEFAULT_REPO,
    trackerIssue: null,
    analysisFile: null,
    candidateId: null,
    stateCommitSha: null,
    outcome: null,
    notes: "",
    prUrl: null,
    assertTerminal: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") args.repo = argv[++index] ?? args.repo;
    else if (argument === "--tracker-issue")
      args.trackerIssue = Number(argv[++index]);
    else if (argument === "--analysis-file")
      args.analysisFile = argv[++index] ?? null;
    else if (argument === "--candidate-id")
      args.candidateId = argv[++index] ?? null;
    else if (argument === "--state-commit-sha")
      args.stateCommitSha = argv[++index] ?? null;
    else if (argument === "--outcome")
      args.outcome = parseOutcome(argv[++index]);
    else if (argument === "--notes") args.notes = argv[++index] ?? "";
    else if (argument === "--pr-url") args.prUrl = argv[++index] ?? null;
    else if (argument === "--assert-terminal") args.assertTerminal = true;
    else if (argument === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!args.trackerIssue || Number.isNaN(args.trackerIssue))
    throw new Error("--tracker-issue is required");
  if (args.assertTerminal) {
    if (!args.candidateId || !args.stateCommitSha)
      throw new Error(
        "--candidate-id and --state-commit-sha are required with --assert-terminal",
      );
  } else {
    if (!args.analysisFile) throw new Error("--analysis-file is required");
    if (!args.outcome) throw new Error("--outcome is required");
    if (isTerminalOutcome(args.outcome) && !args.stateCommitSha)
      throw new Error("terminal outcomes require --state-commit-sha");
    if (args.outcome === "pr_created" && !args.prUrl)
      throw new Error("--pr-url is required for pr_created");
  }
  return args;
}

function parseOutcome(value: string | undefined): ClaudeWatchOutcome {
  if (
    value === "recorded_noop" ||
    value === "no_local_impact" ||
    value === "pr_created" ||
    value === "needs_human_review" ||
    value === "error"
  ) {
    return value;
  }
  throw new Error(`Unknown outcome: ${value}`);
}

export function verifyStateCandidate(
  candidateId: string,
  stateCommitSha: string,
  repoPath = process.cwd(),
): void {
  const tip = resolveStateBranchTip(repoPath);
  if (tip !== stateCommitSha) {
    throw new Error(
      `Claude state tip ${tip ?? "missing"} does not match ${stateCommitSha}`,
    );
  }
  const snapshot = loadStateSnapshotAtCommit(repoPath, stateCommitSha);
  if (snapshot?.candidate_id !== candidateId) {
    throw new Error(
      `Claude state candidate ${snapshot?.candidate_id ?? "missing"} does not match ${candidateId}`,
    );
  }
}

function verifyParityPr(
  repo: string,
  prUrl: string,
  candidateId: string,
): void {
  const pr = ghJson<{
    isDraft: boolean;
    author: { login: string };
    body: string | null;
  }>(["pr", "view", prUrl, "--repo", repo, "--json", "isDraft,author,body"]);
  if (!pr.isDraft || pr.author.login !== "carenthomas") {
    throw new Error(
      `Parity PR must be a draft authored by carenthomas (got draft=${pr.isDraft}, author=${pr.author.login})`,
    );
  }
  if (!pr.body?.includes(`Claude-watch: ${candidateId}`)) {
    throw new Error("Parity PR body is missing the exact Claude-watch marker");
  }
}

export function main(argv = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const issue = args.trackerIssue as number;
  const state = parseTrackerState(getIssueBody(args.repo, issue));

  if (args.assertTerminal) {
    verifyStateCandidate(
      args.candidateId as string,
      args.stateCommitSha as string,
    );
    const entry = findTrackerEntry(state, args.candidateId as string);
    if (
      !entry ||
      !hasProcessedCandidate(state, args.candidateId as string) ||
      entry.state_commit_sha !== args.stateCommitSha
    ) {
      throw new Error(
        `Candidate ${args.candidateId} does not have a matching terminal tracker outcome`,
      );
    }
    console.log(`Verified terminal Claude outcome for ${args.candidateId}`);
    return;
  }

  const analysis = JSON.parse(
    readFileSync(args.analysisFile as string, "utf8"),
  ) as ClaudeWatchAnalysis;
  if (isTerminalOutcome(args.outcome as ClaudeWatchOutcome)) {
    verifyStateCandidate(analysis.candidate_id, args.stateCommitSha as string);
  }
  if (args.outcome === "pr_created") {
    verifyParityPr(args.repo, args.prUrl as string, analysis.candidate_id);
  }
  const next = recordAnalysis(state, {
    analysis,
    outcome: args.outcome as ClaudeWatchOutcome,
    notes: args.notes || defaultNotes(args.outcome as ClaudeWatchOutcome),
    prUrl: args.prUrl,
    stateCommitSha: args.stateCommitSha,
    error:
      args.outcome === "error" ? (analysis.errors.at(-1) ?? args.notes) : null,
  });
  const nextBody = renderTrackerBody(next);
  if (args.dryRun) console.log(nextBody);
  else editIssueBody(args.repo, issue, nextBody);
  console.log(
    `Recorded ${analysis.candidate_id} as ${args.outcome} in #${issue}`,
  );
}

function defaultNotes(outcome: ClaudeWatchOutcome): string {
  switch (outcome) {
    case "recorded_noop":
      return "no watched Claude surface changed";
    case "no_local_impact":
      return "reviewed; no local Letta Code mirror impact";
    case "pr_created":
      return "opened a focused local mirror PR";
    case "needs_human_review":
      return "public evidence needs human review";
    case "error":
      return "retryable watcher error";
  }
}

if (import.meta.main) main();
