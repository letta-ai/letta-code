#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { editIssueBody, getIssueBody, ghJson } from "./github.ts";
import {
  DEFAULT_TARGET_REPO,
  type PiAiWatchAnalysis,
} from "./release-analysis.ts";
import {
  hasRecordedOutcome,
  parseTrackerState,
  recordAnalysis,
  renderTrackerBody,
  type TrackerOutcome,
} from "./tracker.ts";

interface Args {
  repo: string;
  trackerIssue: number | null;
  analysisFile: string | null;
  outcome: TrackerOutcome | null;
  notes: string;
  prUrl: string | null;
  expectedGithubLogin: string | null;
  previousVersion: string | null;
  currentVersion: string | null;
  assertRecorded: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: DEFAULT_TARGET_REPO,
    trackerIssue: null,
    analysisFile: null,
    outcome: null,
    notes: "",
    prUrl: null,
    expectedGithubLogin: null,
    previousVersion: null,
    currentVersion: null,
    assertRecorded: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") args.repo = argv[++index] ?? args.repo;
    else if (argument === "--tracker-issue") {
      args.trackerIssue = Number(argv[++index]);
    } else if (argument === "--analysis-file") {
      args.analysisFile = argv[++index] ?? null;
    } else if (argument === "--outcome") {
      args.outcome = parseOutcome(argv[++index]);
    } else if (argument === "--notes") args.notes = argv[++index] ?? "";
    else if (argument === "--pr-url") args.prUrl = argv[++index] ?? null;
    else if (argument === "--expected-github-login") {
      args.expectedGithubLogin = argv[++index] ?? null;
    } else if (argument === "--previous-version") {
      args.previousVersion = argv[++index] ?? null;
    } else if (argument === "--current-version") {
      args.currentVersion = argv[++index] ?? null;
    } else if (argument === "--assert-recorded") args.assertRecorded = true;
    else if (argument === "--dry-run") args.dryRun = true;
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: bun scripts/pi-ai-watch/update-tracker.ts --tracker-issue ISSUE [--analysis-file FILE --outcome OUTCOME --notes TEXT --pr-url URL --expected-github-login LOGIN] [--assert-recorded --previous-version VERSION --current-version VERSION] [--repo OWNER/REPO] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!args.trackerIssue || Number.isNaN(args.trackerIssue)) {
    throw new Error("--tracker-issue is required");
  }
  if (args.assertRecorded) {
    if (!args.previousVersion || !args.currentVersion) {
      throw new Error(
        "--previous-version and --current-version are required with --assert-recorded",
      );
    }
    return args;
  }
  if (!args.analysisFile) throw new Error("--analysis-file is required");
  if (!args.outcome) throw new Error("--outcome is required");
  if (args.outcome === "pr_created") {
    if (!args.prUrl) throw new Error("--pr-url is required for pr_created");
    if (!args.expectedGithubLogin) {
      throw new Error("--expected-github-login is required for pr_created");
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const issueNumber = args.trackerIssue as number;
  const body = getIssueBody(args.repo, issueNumber);
  const state = parseTrackerState(body);

  if (args.assertRecorded) {
    if (
      !hasRecordedOutcome(
        state,
        args.previousVersion as string,
        args.currentVersion as string,
      )
    ) {
      throw new Error(
        `No recorded pi-ai outcome for ${args.previousVersion}...${args.currentVersion}`,
      );
    }
    console.log(
      `Verified pi-ai outcome ${args.previousVersion}...${args.currentVersion}`,
    );
    return;
  }

  const analysis = JSON.parse(
    readFileSync(args.analysisFile as string, "utf8"),
  ) as PiAiWatchAnalysis;
  if (args.outcome === "pr_created") {
    verifyUpgradePr(
      args.prUrl as string,
      args.repo,
      args.expectedGithubLogin as string,
      analysis,
    );
  }

  const next = recordAnalysis(state, {
    analysis,
    outcome: args.outcome as TrackerOutcome,
    notes: args.notes || defaultNotes(args.outcome as TrackerOutcome),
    prUrl: args.prUrl,
  });
  const nextBody = renderTrackerBody(next);
  if (args.dryRun) {
    console.log(nextBody);
    return;
  }
  editIssueBody(args.repo, issueNumber, nextBody);
  console.log(
    `Recorded pi-ai ${analysis.current_version} as ${args.outcome} in #${issueNumber}`,
  );
}

function verifyUpgradePr(
  prUrl: string,
  expectedRepo: string,
  expectedGithubLogin: string,
  analysis: PiAiWatchAnalysis,
): void {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(
    prUrl,
  );
  if (!match) throw new Error(`Invalid GitHub pull request URL ${prUrl}`);
  const [, owner, repo, number] = match;
  if (`${owner}/${repo}` !== expectedRepo) {
    throw new Error(`pi-ai upgrade PR must belong to ${expectedRepo}`);
  }
  const pull = ghJson<{
    author: { login: string };
    body: string;
    isDraft: boolean;
    state: string;
  }>([
    "pr",
    "view",
    number as string,
    "--repo",
    `${owner}/${repo}`,
    "--json",
    "author,body,isDraft,state",
  ]);
  const marker = `Pi-ai-watch: ${analysis.previous_version}...${analysis.current_version}`;
  if (pull.author.login !== expectedGithubLogin) {
    throw new Error(
      `pi-ai PR author ${pull.author.login} does not match ${expectedGithubLogin}`,
    );
  }
  if (!pull.isDraft) throw new Error("pi-ai upgrade PR must be a draft");
  if (pull.state !== "OPEN") throw new Error("pi-ai upgrade PR must be open");
  if (!pull.body.includes(marker)) {
    throw new Error(`pi-ai upgrade PR is missing marker: ${marker}`);
  }
}

function parseOutcome(value: string | undefined): TrackerOutcome {
  if (
    value === "no_upgrade" ||
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
    case "no_upgrade":
      return "reviewed; no upgrade needed for this release";
    case "pr_created":
      return "opened pi-ai dependency upgrade PR";
    case "needs_human_review":
      return "needs human review";
    case "error":
      return "automation hit an error; retry this release";
  }
}

main();
