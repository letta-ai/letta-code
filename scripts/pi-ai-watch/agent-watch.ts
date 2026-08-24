#!/usr/bin/env bun

import { appendFileSync, writeFileSync } from "node:fs";
import {
  createIssueWithBody,
  editIssueBody,
  ensureLabels,
  findIssueByExactTitle,
  getIssueBody,
  getPullRequestStatus,
} from "./github.ts";
import {
  analyzePiAiRelease,
  compareStableVersions,
  DEFAULT_TARGET_REPO,
  findNextStableRelease,
  listStableReleases,
  readInstalledVersion,
} from "./release-analysis.ts";
import {
  advanceMergedPr,
  getPendingPrForCursor,
  hasCompletedRange,
  initialTrackerState,
  parseTrackerState,
  renderTrackerBody,
} from "./tracker.ts";

const DEFAULT_TRACKER_TITLE = "pi-ai dependency upgrade tracker";
const DEFAULT_ANALYSIS_FILE = "pi-ai-watch-analysis.json";

interface Args {
  dryRun: boolean;
  previousVersion: string | null;
  currentVersion: string | null;
  repo: string;
  trackerTitle: string;
  analysisFile: string;
}

interface TrackerIssue {
  number: number;
  url: string;
  body: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    previousVersion: null,
    currentVersion: null,
    repo: DEFAULT_TARGET_REPO,
    trackerTitle: DEFAULT_TRACKER_TITLE,
    analysisFile: DEFAULT_ANALYSIS_FILE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") args.dryRun = true;
    else if (argument === "--previous-version") {
      args.previousVersion = argv[++index] ?? null;
    } else if (argument === "--current-version") {
      args.currentVersion = argv[++index] ?? null;
    } else if (argument === "--repo") {
      args.repo = argv[++index] ?? args.repo;
    } else if (argument === "--tracker-title") {
      args.trackerTitle = argv[++index] ?? args.trackerTitle;
    } else if (argument === "--analysis-file") {
      args.analysisFile = argv[++index] ?? args.analysisFile;
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: bun scripts/pi-ai-watch/agent-watch.ts [--dry-run] [--previous-version VERSION] [--current-version VERSION] [--repo OWNER/REPO] [--tracker-title TITLE] [--analysis-file FILE]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const installedVersion = readInstalledVersion();
  const tracker = ensureTrackerIssue(args, installedVersion);
  let state = parseTrackerState(tracker.body);
  const releases = await listStableReleases();
  let previousVersion = args.previousVersion;
  let currentVersion = args.currentVersion;
  const isScheduledSelection = !previousVersion && !currentVersion;

  if (isScheduledSelection) {
    const pending = getPendingPrForCursor(state);
    if (pending?.pr_url) {
      const status = getPullRequestStatus(pending.pr_url);
      if (status.state === "OPEN") {
        console.log(`Waiting for pending pi-ai upgrade PR: ${status.url}`);
        writeCommonOutputs(tracker, {
          installedVersion,
          previousVersion: pending.previous_version,
          currentVersion: pending.version,
        });
        writeOutput("pending_pr_url", status.url);
        writeOutput("should_run_agent", "false");
        return;
      }
      if (status.state === "MERGED") {
        if (compareStableVersions(installedVersion, pending.version) < 0) {
          throw new Error(
            `Merged pi-ai PR ${status.url} targets ${pending.version}, but main still declares ${installedVersion}`,
          );
        }
        state = advanceMergedPr(state, pending.version);
        if (!args.dryRun) {
          editIssueBody(args.repo, tracker.number, renderTrackerBody(state));
        }
      } else {
        console.log(
          `Retrying ${pending.version}; prior PR was closed unmerged.`,
        );
      }
    }

    const next = findNextStableRelease(releases, state.audit_cursor_version);
    if (!next) {
      console.log(
        `No stable pi-ai release after ${state.audit_cursor_version}.`,
      );
      writeCommonOutputs(tracker, {
        installedVersion,
        previousVersion: state.audit_cursor_version,
        currentVersion: state.audit_cursor_version,
      });
      writeOutput("should_run_agent", "false");
      return;
    }
    previousVersion = state.audit_cursor_version;
    currentVersion = next.version;
  }

  const analysis = await analyzePiAiRelease({
    previousVersion,
    currentVersion,
    installedVersion,
    stableReleases: releases,
  });
  writeFileSync(args.analysisFile, `${JSON.stringify(analysis, null, 2)}\n`);
  writeCommonOutputs(tracker, {
    installedVersion,
    previousVersion: analysis.previous_version,
    currentVersion: analysis.current_version,
  });
  writeOutput("analysis_file", args.analysisFile);

  if (
    !args.dryRun &&
    hasCompletedRange(
      state,
      analysis.previous_version,
      analysis.current_version,
    )
  ) {
    console.log(
      `Already completed pi-ai review ${analysis.previous_version}...${analysis.current_version}.`,
    );
    writeOutput("should_run_agent", "false");
    return;
  }

  if (args.dryRun) {
    console.log(JSON.stringify(analysis, null, 2));
    writeOutput("should_run_agent", "false");
    return;
  }

  console.log(
    `pi-ai ${analysis.previous_version}...${analysis.current_version} needs Amelia review.`,
  );
  writeOutput("should_run_agent", "true");
}

function ensureTrackerIssue(
  args: Args,
  installedVersion: string,
): TrackerIssue {
  const existing = args.dryRun
    ? null
    : findIssueByExactTitle(args.repo, args.trackerTitle);
  if (existing) {
    return {
      number: existing.number,
      url: `https://github.com/${args.repo}/issues/${existing.number}`,
      body: getIssueBody(args.repo, existing.number),
    };
  }

  const body = renderTrackerBody(initialTrackerState(installedVersion));
  if (args.dryRun) {
    return {
      number: 0,
      url: `https://github.com/${args.repo}/issues/0`,
      body,
    };
  }

  const labels = ["pi-ai-watch", "automation"];
  ensureLabels(args.repo, labels);
  const issueUrl = createIssueWithBody(
    args.repo,
    args.trackerTitle,
    body,
    labels,
  );
  return {
    number: issueNumberFromUrl(issueUrl),
    url: issueUrl,
    body,
  };
}

function issueNumberFromUrl(issueUrl: string): number {
  const issueNumber = Number(issueUrl.trim().split("/").at(-1));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Could not parse issue number from ${issueUrl}`);
  }
  return issueNumber;
}

function writeCommonOutputs(
  tracker: TrackerIssue,
  versions: {
    installedVersion: string;
    previousVersion: string;
    currentVersion: string;
  },
): void {
  writeOutput("tracker_issue", String(tracker.number));
  writeOutput("tracker_issue_url", tracker.url);
  writeOutput("installed_version", versions.installedVersion);
  writeOutput("previous_version", versions.previousVersion);
  writeOutput("current_version", versions.currentVersion);
}

function writeOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value}\n`);
}

main().catch((error) => {
  console.error(error);
  writeOutput("should_run_agent", "false");
  process.exit(1);
});
