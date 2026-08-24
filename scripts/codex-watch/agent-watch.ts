#!/usr/bin/env bun
/**
 * Amelia-driven Codex release watcher entrypoint.
 *
 * Uses a central tracker issue for state and only asks Amelia to review
 * non-noop releases.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import {
  createIssueWithBody,
  editIssueBody,
  ensureLabels,
  findIssueByExactTitle,
  getIssueBody,
} from "./github.ts";
import {
  analyzeCodexRelease,
  DEFAULT_TARGET_REPO,
  findNextStableRelease,
  listStableReleases,
  type Release,
} from "./release-analysis.ts";
import {
  advanceCodexAuditCursor,
  emptyTrackerState,
  getCodexAuditCursorTag,
  hasProcessedRange,
  parseTrackerState,
  recordAnalysis,
  renderTrackerBody,
  validateLegacyCodexAuditCursor,
} from "./tracker.ts";

const DEFAULT_TRACKER_TITLE = "Codex upstream drift tracker";
const DEFAULT_ANALYSIS_FILE = "codex-watch-analysis.json";

interface Args {
  dryRun: boolean;
  sinceTag: string | null;
  currentTag: string | null;
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
    sinceTag: null,
    currentTag: null,
    repo: DEFAULT_TARGET_REPO,
    trackerTitle: DEFAULT_TRACKER_TITLE,
    analysisFile: DEFAULT_ANALYSIS_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--since") args.sinceTag = argv[++i] ?? null;
    else if (a === "--current") args.currentTag = argv[++i] ?? null;
    else if (a === "--repo") args.repo = argv[++i] ?? args.repo;
    else if (a === "--tracker-title") {
      args.trackerTitle = argv[++i] ?? args.trackerTitle;
    } else if (a === "--analysis-file") {
      args.analysisFile = argv[++i] ?? args.analysisFile;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun scripts/codex-watch/agent-watch.ts [--dry-run] [--since TAG] [--current TAG] [--repo OWNER/REPO] [--tracker-title TITLE] [--analysis-file FILE]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tracker = ensureTrackerIssue(args);
  let state = parseTrackerState(tracker.body);
  let sinceTag = args.sinceTag;
  let currentTag = args.currentTag;
  let stableReleases: Release[] | undefined;

  if (!state.audit_cursor_validated) {
    stableReleases = await listStableReleases();
    state = validateLegacyCodexAuditCursor(
      state,
      stableReleases.map((release) => release.tag_name),
    );
    if (!args.dryRun) {
      editIssueBody(args.repo, tracker.number, renderTrackerBody(state));
    }
  }

  if (!sinceTag && !currentTag) {
    const cursorTag = getCodexAuditCursorTag(state);
    if (cursorTag) {
      stableReleases ??= await listStableReleases();
      const nextRelease = findNextStableRelease(stableReleases, cursorTag);
      if (!nextRelease) {
        console.log(`No stable release after ${cursorTag}; nothing to do.`);
        writeOutput("tracker_issue", String(tracker.number));
        writeOutput("tracker_issue_url", tracker.url);
        writeOutput("current_tag", cursorTag);
        writeOutput("previous_tag", cursorTag);
        writeOutput("verdict", "no-op");
        writeOutput("should_run_agent", "false");
        return;
      }
      sinceTag = cursorTag;
      currentTag = nextRelease.tag_name;
    }
  }

  const analysis = await analyzeCodexRelease({
    sinceTag,
    currentTag,
    stableReleases,
  });
  writeFileSync(args.analysisFile, `${JSON.stringify(analysis, null, 2)}\n`);

  writeOutput("tracker_issue", String(tracker.number));
  writeOutput("tracker_issue_url", tracker.url);
  writeOutput("analysis_file", args.analysisFile);
  writeOutput("current_tag", analysis.current_tag);
  writeOutput("previous_tag", analysis.previous_tag);
  writeOutput("verdict", analysis.verdict);

  if (
    !args.dryRun &&
    hasProcessedRange(state, analysis.previous_tag, analysis.current_tag)
  ) {
    const next = advanceCodexAuditCursor(
      state,
      analysis.previous_tag,
      analysis.current_tag,
      analysis.is_adjacent_release,
    );
    if (next !== state) {
      editIssueBody(args.repo, tracker.number, renderTrackerBody(next));
    }
    console.log(
      `Already processed ${analysis.previous_tag}...${analysis.current_tag}; nothing to do.`,
    );
    writeOutput("should_run_agent", "false");
    return;
  }

  if (analysis.verdict === "no-op") {
    const next = recordAnalysis(state, {
      analysis,
      outcome: "recorded_noop",
      notes: "no watched tool-surface changes detected",
    });
    const nextBody = renderTrackerBody(next);
    if (args.dryRun) {
      console.log(nextBody);
    } else {
      editIssueBody(args.repo, tracker.number, nextBody);
    }
    console.log(`Recorded ${analysis.current_tag} as no-op.`);
    writeOutput("should_run_agent", "false");
    return;
  }

  if (args.dryRun) {
    console.log(JSON.stringify(analysis, null, 2));
    writeOutput("should_run_agent", "false");
    return;
  }

  console.log(
    `Release ${analysis.current_tag} needs Amelia review: ${analysis.verdict}`,
  );
  writeOutput("should_run_agent", "true");
}

function ensureTrackerIssue(args: Args): TrackerIssue {
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

  const body = renderTrackerBody(emptyTrackerState());
  if (args.dryRun) {
    return {
      number: 0,
      url: `https://github.com/${args.repo}/issues/0`,
      body,
    };
  }

  const labels = ["codex-watch", "automation"];
  ensureLabels(args.repo, labels);
  const issueUrl = createIssueWithBody(
    args.repo,
    args.trackerTitle,
    body,
    labels,
  );
  const issueNumber = issueNumberFromUrl(issueUrl);
  return {
    number: issueNumber,
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

function writeOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value}\n`);
}

main().catch((err) => {
  console.error(err);
  writeOutput("should_run_agent", "false");
  process.exit(1);
});
