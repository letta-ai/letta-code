#!/usr/bin/env bun
/** Selects one bundled skill for a fresh semantic staleness review. */

import { appendFileSync, writeFileSync } from "node:fs";
import {
  buildAnalysis,
  DEFAULT_TARGET_REPO,
  listBuiltinSkillsAtCommit,
  selectNextSkill,
} from "./analysis.ts";
import {
  createIssueWithBody,
  editIssueBody,
  ensureLabels,
  findIssuesByExactTitle,
  getIssueBody,
  ghJson,
} from "./github.ts";
import {
  emptyTrackerState,
  parseTrackerState,
  renderTrackerBody,
  startCandidate,
  type TrackerState,
} from "./tracker.ts";

const DEFAULT_TRACKER_TITLE = "Built-in skill staleness tracker";
const DEFAULT_ANALYSIS_FILE = "builtin-skills-watch-analysis.json";

interface Args {
  dryRun: boolean;
  skill: string | null;
  currentSha: string | null;
  auditAt: string | null;
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
    skill: null,
    currentSha: null,
    auditAt: null,
    repo: DEFAULT_TARGET_REPO,
    trackerTitle: DEFAULT_TRACKER_TITLE,
    analysisFile: DEFAULT_ANALYSIS_FILE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--skill") args.skill = argv[++index] ?? null;
    else if (arg === "--current-sha") {
      args.currentSha = argv[++index] ?? null;
    } else if (arg === "--audit-at") {
      args.auditAt = argv[++index] ?? null;
    } else if (arg === "--repo") args.repo = argv[++index] ?? args.repo;
    else if (arg === "--tracker-title") {
      args.trackerTitle = argv[++index] ?? args.trackerTitle;
    } else if (arg === "--analysis-file") {
      args.analysisFile = argv[++index] ?? args.analysisFile;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/builtin-skills-watch/agent-watch.ts [--dry-run] [--skill NAME] [--current-sha SHA] [--audit-at ISO] [--repo OWNER/REPO] [--tracker-title TITLE] [--analysis-file FILE]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !workflowRunUrl()) {
    throw new Error("Scheduled watcher runs require GitHub workflow metadata");
  }
  let currentSha = args.currentSha ?? gitHead();
  let auditAt = args.auditAt ?? new Date().toISOString();
  let inventory = listBuiltinSkillsAtCommit(currentSha);
  if (inventory.length === 0) {
    throw new Error(`No bundled skills found at ${currentSha}`);
  }

  let tracker: TrackerIssue | null = null;
  let state = emptyTrackerState();
  if (args.dryRun && !args.skill) {
    tracker = findExistingTrackerIssue(args);
    if (tracker) state = parseTrackerState(tracker.body);
  } else if (!args.dryRun) {
    tracker = ensureTrackerIssue(args, inventory);
    state = parseTrackerState(tracker.body);
  }

  const currentRunUrl = workflowRunUrl();
  const previousRun = currentRunUrl
    ? state.history.find((entry) => entry.workflow_run_url === currentRunUrl)
    : undefined;
  if (previousRun && previousRun.outcome !== "error") {
    writeOutput("tracker_issue", tracker ? String(tracker.number) : "0");
    writeOutput("tracker_issue_url", tracker?.url ?? "");
    writeOutput("skill", previousRun.skill);
    writeOutput("candidate_id", previousRun.candidate_id);
    writeOutput("current_sha", previousRun.current_sha);
    writeOutput("skill_digest", previousRun.skill_digest);
    writeOutput("should_run_agent", "false");
    console.log(
      `Workflow run already recorded ${previousRun.outcome} for ${previousRun.candidate_id}`,
    );
    return;
  }

  const pending = state.pending;
  if (pending) {
    currentSha = pending.current_sha;
    auditAt = pending.audit_at;
    inventory = listBuiltinSkillsAtCommit(currentSha);
  }
  const blockedSkills = pending
    ? new Set<string>()
    : findSkillsWithOpenWatcherPrs(args.repo, state);
  const eligibleInventory = inventory.filter(
    (candidate) => !blockedSkills.has(candidate),
  );
  if (args.skill && blockedSkills.has(args.skill)) {
    writeOutput("tracker_issue", tracker ? String(tracker.number) : "0");
    writeOutput("tracker_issue_url", tracker?.url ?? "");
    writeOutput("skill", args.skill);
    writeOutput("should_run_agent", "false");
    console.log(`${args.skill} is waiting on an open watcher PR`);
    return;
  }
  const skill =
    pending?.skill ??
    args.skill ??
    previousRun?.skill ??
    selectNextSkill(eligibleInventory, state.skills) ??
    undefined;
  if (!skill && blockedSkills.size > 0) {
    writeOutput("tracker_issue", tracker ? String(tracker.number) : "0");
    writeOutput("tracker_issue_url", tracker?.url ?? "");
    writeOutput("should_run_agent", "false");
    console.log("All bundled skills are waiting on open watcher PRs");
    return;
  }
  if (!skill) throw new Error("Could not select a bundled skill to audit");
  if (!inventory.includes(skill)) {
    throw new Error(`Unknown bundled skill: ${skill}`);
  }

  const previous = state.skills[skill];
  const analysis = buildAnalysis({
    skill,
    currentSha,
    auditAt,
    previousAudit:
      pending?.previous_audit ??
      (previous
        ? {
            candidate_id: previous.candidate_id,
            audited_sha: previous.audited_sha,
            skill_digest: previous.skill_digest,
            audited_at: previous.audited_at,
          }
        : null),
  });
  if (pending && pending.candidate_id !== analysis.candidate_id) {
    throw new Error(
      `Pending candidate ${pending.candidate_id} rebuilt as ${analysis.candidate_id}`,
    );
  }
  if (!args.dryRun && !pending) {
    state = startCandidate(state, analysis);
    editTrackerIssue(args.repo, tracker as TrackerIssue, state, inventory);
  }
  writeFileSync(args.analysisFile, `${JSON.stringify(analysis, null, 2)}\n`);

  writeOutput("tracker_issue", tracker ? String(tracker.number) : "0");
  writeOutput("tracker_issue_url", tracker?.url ?? "");
  writeOutput("analysis_file", args.analysisFile);
  writeOutput("skill", analysis.skill);
  writeOutput("candidate_id", analysis.candidate_id);
  writeOutput("current_sha", analysis.current_sha);
  writeOutput("skill_digest", analysis.skill_digest);
  writeOutput("audit_at", analysis.audit_at);
  writeOutput("should_run_agent", args.dryRun ? "false" : "true");

  if (args.dryRun) console.log(JSON.stringify(analysis, null, 2));
  else console.log(`Selected ${skill} for ${analysis.candidate_id}`);
}

function ensureTrackerIssue(args: Args, inventory: string[]): TrackerIssue {
  const existing = findExistingTrackerIssue(args);
  if (existing) return existing;

  const state = emptyTrackerState();
  const body = renderTrackerBody(state, inventory);
  const labels = ["builtin-skills-watch", "automation"];
  ensureLabels(args.repo, labels);
  const issueUrl = createIssueWithBody(
    args.repo,
    args.trackerTitle,
    body,
    labels,
  );
  const issueNumber = Number(issueUrl.trim().split("/").at(-1));
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Could not parse issue number from ${issueUrl}`);
  }
  return { number: issueNumber, url: issueUrl, body };
}

function findExistingTrackerIssue(args: Args): TrackerIssue | null {
  const matches = findIssuesByExactTitle(
    args.repo,
    args.trackerTitle,
    "builtin-skills-watch",
  );
  if (matches.length > 1) {
    throw new Error(
      `Found multiple open ${args.trackerTitle} issues with the builtin-skills-watch label`,
    );
  }
  const existing = matches[0];
  if (!existing) return null;
  if (existing.state !== "OPEN") {
    throw new Error(
      `Tracker issue #${existing.number} is closed; reopen it before running the watcher`,
    );
  }
  if (
    existing.author.login !== "app/github-actions" &&
    existing.author.login !== "github-actions[bot]"
  ) {
    throw new Error(
      `Tracker issue #${existing.number} was created by unexpected author ${existing.author.login}`,
    );
  }
  return {
    number: existing.number,
    url: `https://github.com/${args.repo}/issues/${existing.number}`,
    body: getIssueBody(args.repo, existing.number),
  };
}

function editTrackerIssue(
  repo: string,
  tracker: TrackerIssue,
  state: TrackerState,
  inventory: string[],
): void {
  editIssueBody(repo, tracker.number, renderTrackerBody(state, inventory));
}

function findSkillsWithOpenWatcherPrs(
  repo: string,
  state: TrackerState,
): Set<string> {
  const blocked = new Set<string>();
  const openWatcherPrs = ghJson<Array<{ body: string; url: string }>>([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--search",
    '"Builtin-skill-watch:" in:body',
    "--limit",
    "100",
    "--json",
    "body,url",
  ]);
  for (const pullRequest of openWatcherPrs) {
    const marker = pullRequest.body.match(
      /Builtin-skill-watch:\s*([a-z0-9]+(?:-[a-z0-9]+)*)@/,
    );
    if (marker?.[1]) blocked.add(marker[1]);
  }
  for (const [skill, audit] of Object.entries(state.skills)) {
    if (audit.outcome !== "pr_created" || !audit.pr_url) continue;
    const pullRequest = ghJson<{ state: string }>([
      "pr",
      "view",
      audit.pr_url,
      "--repo",
      repo,
      "--json",
      "state",
    ]);
    if (pullRequest.state === "OPEN") blocked.add(skill);
  }
  return blocked;
}

function gitHead(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function writeOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value}\n`);
}

function workflowRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repository && runId
    ? `${server}/${repository}/actions/runs/${runId}`
    : "";
}

main().catch((error) => {
  console.error(error);
  writeOutput("should_run_agent", "false");
  process.exit(1);
});
