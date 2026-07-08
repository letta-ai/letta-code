#!/usr/bin/env bun
/**
 * Records an Amelia Codex watch outcome in the central tracker issue.
 *
 * Usage:
 *   bun scripts/codex-watch/update-tracker.ts --tracker-issue 123 --analysis-file /tmp/analysis.json --outcome no_local_impact --notes "upstream-only"
 */

import { readFileSync } from "node:fs";
import { editIssueBody, getIssueBody } from "./github.ts";
import {
  type CodexWatchAnalysis,
  DEFAULT_TARGET_REPO,
} from "./release-analysis.ts";
import {
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
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] ?? args.repo;
    else if (a === "--tracker-issue") {
      args.trackerIssue = Number(argv[++i]);
    } else if (a === "--analysis-file") args.analysisFile = argv[++i] ?? null;
    else if (a === "--outcome") args.outcome = parseOutcome(argv[++i]);
    else if (a === "--notes") args.notes = argv[++i] ?? "";
    else if (a === "--pr-url") args.prUrl = argv[++i] ?? null;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun scripts/codex-watch/update-tracker.ts --tracker-issue ISSUE --analysis-file FILE --outcome OUTCOME [--notes TEXT] [--pr-url URL] [--repo OWNER/REPO] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!args.trackerIssue || Number.isNaN(args.trackerIssue)) {
    throw new Error("--tracker-issue is required");
  }
  if (!args.analysisFile) throw new Error("--analysis-file is required");
  if (!args.outcome) throw new Error("--outcome is required");
  if (args.outcome === "pr_created" && !args.prUrl) {
    throw new Error("--pr-url is required when --outcome pr_created");
  }

  return args;
}

function parseOutcome(value: string | undefined): TrackerOutcome {
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

function readAnalysis(path: string): CodexWatchAnalysis {
  return JSON.parse(readFileSync(path, "utf8")) as CodexWatchAnalysis;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const analysis = readAnalysis(args.analysisFile as string);
  const body = getIssueBody(args.repo, args.trackerIssue as number);
  const state = parseTrackerState(body);
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

  editIssueBody(args.repo, args.trackerIssue as number, nextBody);
  console.log(
    `Recorded ${analysis.current_tag} as ${args.outcome} in #${args.trackerIssue}`,
  );
}

function defaultNotes(outcome: TrackerOutcome): string {
  switch (outcome) {
    case "recorded_noop":
      return "no watched tool-surface changes detected";
    case "no_local_impact":
      return "reviewed; no local Letta Code mirror impact";
    case "pr_created":
      return "opened PR for local mirror update";
    case "needs_human_review":
      return "needs human review";
    case "error":
      return "automation hit an error";
  }
}

main();
