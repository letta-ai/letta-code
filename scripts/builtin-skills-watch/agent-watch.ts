#!/usr/bin/env bun
/** Prepares one candidate for every bundled skill in a daily parallel review. */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildAnalysis,
  DEFAULT_TARGET_REPO,
  listBuiltinSkillsAtCommit,
  type PriorSkillAudit,
} from "./analysis.ts";
import {
  createIssueWithBody,
  editIssueBody,
  ensureLabels,
  findIssuesByExactTitle,
  getIssueBody,
} from "./github.ts";
import {
  emptyTrackerState,
  isTerminalOutcome,
  type PendingCandidate,
  parseTrackerState,
  renderTrackerBody,
  startCandidate,
  type TrackerState,
} from "./tracker.ts";

const DEFAULT_TRACKER_TITLE = "Built-in skill staleness tracker";
const DEFAULT_ANALYSIS_DIR = "builtin-skills-watch-analyses";
const DEFAULT_MANIFEST_FILE = "builtin-skills-watch-manifest.json";
const MAX_SKILLS_PER_RUN = 50;

interface Args {
  dryRun: boolean;
  skill: string | null;
  currentSha: string | null;
  auditAt: string | null;
  previousAuditBase64: string | null;
  repo: string;
  trackerTitle: string;
  analysisDir: string;
  manifestFile: string;
}

interface TrackerIssue {
  number: number;
  url: string;
  body: string;
}

interface MatrixEntry {
  skill: string;
  candidate_id: string;
  current_sha: string;
  skill_digest: string;
  audit_at: string;
  previous_audit_base64: string;
}

interface WatchManifest {
  schema_version: 1;
  tracker_issue: number;
  tracker_issue_url: string;
  inventory: string[];
  candidates: MatrixEntry[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    skill: null,
    currentSha: null,
    auditAt: null,
    previousAuditBase64: null,
    repo: DEFAULT_TARGET_REPO,
    trackerTitle: DEFAULT_TRACKER_TITLE,
    analysisDir: DEFAULT_ANALYSIS_DIR,
    manifestFile: DEFAULT_MANIFEST_FILE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--skill") args.skill = argv[++index] ?? null;
    else if (arg === "--current-sha") {
      args.currentSha = argv[++index] ?? null;
    } else if (arg === "--audit-at") {
      args.auditAt = argv[++index] ?? null;
    } else if (arg === "--previous-audit-base64") {
      args.previousAuditBase64 = argv[++index] ?? null;
    } else if (arg === "--repo") args.repo = argv[++index] ?? args.repo;
    else if (arg === "--tracker-title") {
      args.trackerTitle = argv[++index] ?? args.trackerTitle;
    } else if (arg === "--analysis-dir") {
      args.analysisDir = argv[++index] ?? args.analysisDir;
    } else if (arg === "--manifest-file") {
      args.manifestFile = argv[++index] ?? args.manifestFile;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun scripts/builtin-skills-watch/agent-watch.ts [--dry-run] [--skill NAME] [--current-sha SHA] [--audit-at ISO] [--previous-audit-base64 BASE64] [--repo OWNER/REPO] [--tracker-title TITLE] [--analysis-dir DIR] [--manifest-file FILE]",
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
  const currentSha = args.currentSha ?? gitHead();
  const auditAt = args.auditAt ?? new Date().toISOString();
  const inventory = listBuiltinSkillsAtCommit(currentSha);
  if (inventory.length === 0) {
    throw new Error(`No bundled skills found at ${currentSha}`);
  }
  if (args.skill && !inventory.includes(args.skill)) {
    throw new Error(`Unknown bundled skill: ${args.skill}`);
  }

  const tracker = args.dryRun ? null : ensureTrackerIssue(args, inventory);
  let state = tracker ? parseTrackerState(tracker.body) : emptyTrackerState();
  const selectedSkills = args.skill ? [args.skill] : inventory;
  if (selectedSkills.length > MAX_SKILLS_PER_RUN) {
    throw new Error(
      `Bundled skill count ${selectedSkills.length} exceeds the explicit daily watcher limit of ${MAX_SKILLS_PER_RUN}`,
    );
  }
  const candidates: MatrixEntry[] = [];
  const explicitPreviousAudit = parsePreviousAudit(args.previousAuditBase64);
  mkdirSync(args.analysisDir, { recursive: true });

  for (const skill of selectedSkills) {
    if (wasCompletedInCurrentRun(state, skill)) continue;
    const pending = state.pending[skill];
    const analysis = buildAnalysis({
      skill,
      currentSha: pending?.current_sha ?? currentSha,
      auditAt: pending?.audit_at ?? auditAt,
      previousAudit: explicitPreviousAudit ?? priorAudit(state, skill),
    });
    if (pending) {
      assertPendingRebuild(pending, analysis.candidate_id);
      analysis.workflow_run_url = workflowRunUrlFromId(pending.workflow_run_id);
    } else if (!args.dryRun) state = startCandidate(state, analysis);

    writeFileSync(
      join(args.analysisDir, `${skill}.json`),
      `${JSON.stringify(analysis, null, 2)}\n`,
    );
    candidates.push({
      skill: analysis.skill,
      candidate_id: analysis.candidate_id,
      current_sha: analysis.current_sha,
      skill_digest: analysis.skill_digest,
      audit_at: analysis.audit_at,
      previous_audit_base64: Buffer.from(
        JSON.stringify(analysis.previous_audit),
      ).toString("base64"),
    });
  }

  if (tracker && candidates.length > 0) {
    editIssueBody(
      args.repo,
      tracker.number,
      renderTrackerBody(state, inventory),
    );
  }
  const manifest: WatchManifest = {
    schema_version: 1,
    tracker_issue: tracker?.number ?? 0,
    tracker_issue_url: tracker?.url ?? "",
    inventory,
    candidates,
  };
  writeFileSync(args.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  writeOutput("tracker_issue", String(manifest.tracker_issue));
  writeOutput("tracker_issue_url", manifest.tracker_issue_url);
  writeOutput("analysis_dir", args.analysisDir);
  writeOutput("manifest_file", args.manifestFile);
  writeOutput("matrix", JSON.stringify({ include: candidates }));
  writeOutput(
    "should_run_agent",
    !args.dryRun && candidates.length > 0 ? "true" : "false",
  );

  if (args.dryRun) console.log(JSON.stringify(manifest, null, 2));
  else console.log(`Prepared ${candidates.length} bundled skill reviews`);
}

function parsePreviousAudit(value: string | null): PriorSkillAudit | null {
  if (!value) return null;
  const parsed = JSON.parse(
    Buffer.from(value, "base64").toString("utf8"),
  ) as PriorSkillAudit | null;
  if (parsed === null) return null;
  if (
    typeof parsed.candidate_id !== "string" ||
    typeof parsed.audited_sha !== "string" ||
    typeof parsed.skill_digest !== "string" ||
    typeof parsed.audited_at !== "string"
  ) {
    throw new Error("Previous audit input is invalid");
  }
  return parsed;
}

function priorAudit(
  state: TrackerState,
  skill: string,
): PriorSkillAudit | null {
  const previous = state.skills[skill];
  return previous
    ? {
        candidate_id: previous.candidate_id,
        audited_sha: previous.audited_sha,
        skill_digest: previous.skill_digest,
        audited_at: previous.audited_at,
      }
    : null;
}

function wasCompletedInCurrentRun(state: TrackerState, skill: string): boolean {
  const runId = workflowRunUrl().split("/").at(-1);
  const audit = state.skills[skill];
  return Boolean(
    audit &&
      audit.workflow_run_id === runId &&
      isTerminalOutcome(audit.outcome),
  );
}

function assertPendingRebuild(
  pending: PendingCandidate,
  candidateId: string,
): void {
  if (pending.candidate_id !== candidateId) {
    throw new Error(
      `Pending candidate ${pending.candidate_id} rebuilt as ${candidateId}`,
    );
  }
}

function ensureTrackerIssue(args: Args, inventory: string[]): TrackerIssue {
  const existing = findExistingTrackerIssue(args);
  if (existing) return existing;

  const body = renderTrackerBody(emptyTrackerState(), inventory);
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
      `Found multiple ${args.trackerTitle} issues with the builtin-skills-watch label`,
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

function workflowRunUrlFromId(runId: string): string {
  return `https://github.com/letta-ai/letta-code/actions/runs/${runId}`;
}

main().catch((error) => {
  console.error(error);
  writeOutput("should_run_agent", "false");
  process.exit(1);
});
