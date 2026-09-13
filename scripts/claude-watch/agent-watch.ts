#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type CapturedDocs,
  captureDocsSnapshot,
  sha256,
} from "./docs-snapshot.ts";
import {
  createIssue,
  editIssueBody,
  ensureLabel,
  findIssueByExactTitle,
  getIssueBody,
} from "./github.ts";
import {
  analyzeClaudeCandidate,
  buildClaudeStateSnapshot,
  rebuildClaudeAnalysisFromState,
} from "./release-analysis.ts";
import {
  fetchClaudeGitHubReleases,
  fetchClaudeNpmMetadata,
  selectClaudeReleaseCandidate,
} from "./release-source.ts";
import {
  captureClaudeRuntime,
  createClaudeRuntimeCommandPlan,
  isClaudeProbeContractCurrent,
} from "./runtime-probe.ts";
import {
  fetchStateBranchTip,
  finalizeStateBranch,
  loadStateFilesAtCommit,
  loadStateSnapshotAtCommit,
} from "./state-branch.ts";
import {
  type ClaudeTrackerState,
  findTrackerEntry,
  hasProcessedCandidate,
  isTerminalOutcome,
  parseTrackerState,
  recordAnalysis,
  renderTrackerBody,
} from "./tracker.ts";
import {
  CLAUDE_WATCH_STATE_SCHEMA_VERSION,
  type ClaudeReleaseCandidate,
  type ClaudeRuntimeSnapshot,
  type ClaudeWatchAnalysis,
  type ClaudeWatchOutcome,
  type ClaudeWatchStateSnapshot,
} from "./types.ts";

const DEFAULT_REPO = "letta-ai/letta-code";
const TRACKER_TITLE = "Claude upstream drift tracker";
const TRACKER_LABEL = "claude-watch";

interface Args {
  repo: string;
  analysisFile: string;
  previousVersion: string | null;
  currentVersion: string | null;
  forceDocsScan: boolean;
  dryRun: boolean;
  validationOnly: boolean;
  rebuildStateCommit: string | null;
}

interface TrackerContext {
  number: number;
  url: string;
  state: ClaudeTrackerState;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    repo: DEFAULT_REPO,
    analysisFile: join(tmpdir(), "claude-watch-analysis.json"),
    previousVersion: null,
    currentVersion: null,
    forceDocsScan: false,
    dryRun: false,
    validationOnly: false,
    rebuildStateCommit: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") args.repo = argv[++index] ?? args.repo;
    else if (argument === "--analysis-file")
      args.analysisFile = argv[++index] ?? args.analysisFile;
    else if (argument === "--previous-version")
      args.previousVersion = argv[++index] ?? null;
    else if (argument === "--current-version")
      args.currentVersion = argv[++index] ?? null;
    else if (argument === "--force-docs-scan") args.forceDocsScan = true;
    else if (argument === "--dry-run") args.dryRun = true;
    else if (argument === "--validation-only") args.validationOnly = true;
    else if (argument === "--rebuild-state-commit")
      args.rebuildStateCommit = argv[++index] ?? null;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return args;
}

function workflowRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO;
  const run = process.env.GITHUB_RUN_ID;
  return run ? `${server}/${repo}/actions/runs/${run}` : "local-dry-run";
}

function setOutput(name: string, value: string | number | boolean): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output)
    writeFileSync(output, `${name}=${String(value)}\n`, { flag: "a" });
  else console.log(`${name}=${String(value)}`);
}

function writeAnalysis(path: string, analysis: ClaudeWatchAnalysis): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(analysis, null, 2)}\n`);
}

function ensureTracker(repo: string, dryRun: boolean): TrackerContext {
  const existing = findIssueByExactTitle(repo, TRACKER_TITLE);
  if (existing) {
    return {
      number: existing.number,
      url: existing.url,
      state: parseTrackerState(existing.body),
    };
  }
  if (dryRun)
    return { number: 0, url: "dry-run", state: parseTrackerState("") };
  ensureLabel(repo, TRACKER_LABEL);
  const emptyBody = renderTrackerBody(parseTrackerState(""));
  const created = createIssue(repo, TRACKER_TITLE, emptyBody, TRACKER_LABEL);
  return {
    number: created.number,
    url: created.url,
    state: parseTrackerState(created.body),
  };
}

function recordTrackerOutcome(
  repo: string,
  tracker: TrackerContext,
  analysis: ClaudeWatchAnalysis,
  outcome: ClaudeWatchOutcome,
  notes: string,
  stateCommitSha: string | null,
  error: string | null = null,
): TrackerContext {
  const current = parseTrackerState(getIssueBody(repo, tracker.number));
  const next = recordAnalysis(current, {
    analysis,
    outcome,
    notes,
    stateCommitSha,
    error,
  });
  editIssueBody(repo, tracker.number, renderTrackerBody(next));
  return { ...tracker, state: next };
}

function trackerOutputs(tracker: TrackerContext): void {
  setOutput("tracker_issue", tracker.number);
  setOutput("tracker_issue_url", tracker.url);
}

function analysisOutputs(
  analysis: ClaudeWatchAnalysis,
  shouldRunAgent: boolean,
  stateCommitSha: string | null,
): void {
  setOutput("should_run_agent", shouldRunAgent);
  setOutput("candidate_id", analysis.candidate_id);
  setOutput("previous_version", analysis.previous_version ?? "");
  setOutput("current_version", analysis.current_version);
  setOutput("verdict", analysis.verdict);
  setOutput("state_commit_sha", stateCommitSha ?? "");
}

function stateSources(repoPath: string, commitSha: string | null) {
  if (!commitSha) return {};
  return Object.fromEntries(
    Object.entries(loadStateFilesAtCommit(repoPath, commitSha)).filter(
      ([path]) => path.startsWith("sources/"),
    ),
  );
}

function releaseForState(
  snapshot: ClaudeWatchStateSnapshot,
): ClaudeReleaseCandidate {
  return {
    version: snapshot.package_version,
    published_at: snapshot.npm_published_at,
    integrity: snapshot.npm_integrity,
    tarball_url: "",
    release_url: snapshot.release_url,
    release_notes_md: snapshot.release_notes_md,
    release_published_at: snapshot.release_published_at,
    dist_tags: snapshot.dist_tags,
  };
}

async function selectCandidate(
  state: ClaudeWatchStateSnapshot | null,
  args: Args,
): Promise<ClaudeReleaseCandidate> {
  const [githubReleases, npmMetadata] = await Promise.all([
    fetchClaudeGitHubReleases(),
    fetchClaudeNpmMetadata(),
  ]);
  const selected = selectClaudeReleaseCandidate({
    githubReleases,
    npmMetadata,
    previousVersion: args.previousVersion ?? state?.package_version ?? null,
    currentVersion: args.currentVersion,
    allowNpmOnlyExactVersions: args.validationOnly,
  });
  if (selected) return selected;
  const latest = selectClaudeReleaseCandidate({
    githubReleases,
    npmMetadata,
    currentVersion: npmMetadata.dist_tags.latest,
  });
  if (!latest) throw new Error("Claude latest release could not be selected");
  return latest;
}

async function captureRuntimePair(
  candidate: ClaudeReleaseCandidate,
  previous: ClaudeWatchStateSnapshot | null,
  args: Args,
  runBehaviorProbes: boolean,
): Promise<{
  previousRuntime: ClaudeRuntimeSnapshot | null;
  currentRuntime: ClaudeRuntimeSnapshot | null;
}> {
  const previousVersion =
    args.previousVersion ?? previous?.package_version ?? null;
  const packageChanged = previousVersion !== candidate.version;
  if (args.dryRun) {
    const root = join(tmpdir(), "claude-watch-dry-run");
    const plans = [
      ...(packageChanged && previousVersion
        ? [
            createClaudeRuntimeCommandPlan(
              previousVersion,
              join(root, "previous"),
            ),
          ]
        : []),
      ...(packageChanged || !previous?.runtime
        ? [
            createClaudeRuntimeCommandPlan(
              candidate.version,
              join(root, "current"),
            ),
          ]
        : []),
    ];
    console.log(
      JSON.stringify(
        {
          dry_run_runtime_commands: plans.map((plan) => ({
            package: plan.packageSpec,
            install: [plan.install.command, ...plan.install.args],
            public: [
              [plan.version.command, ...plan.version.args],
              [plan.help.command, ...plan.help.args],
              [plan.doctor.command, ...plan.doctor.args],
              [plan.autoModeDefaults.command, ...plan.autoModeDefaults.args],
            ],
            authenticated: [
              [plan.init.command, ...plan.init.args],
              ...(runBehaviorProbes
                ? plan.probes.map(({ command }) => [
                    command.command,
                    ...command.args,
                  ])
                : []),
            ],
          })),
        },
        null,
        2,
      ),
    );
    return {
      previousRuntime: previous?.runtime ?? null,
      currentRuntime: previous?.runtime ?? null,
    };
  }
  if (!packageChanged) {
    const currentRuntime = await captureClaudeRuntime({
      version: candidate.version,
      tempDir: tmpdir(),
      requireAuth: true,
      reuseProbes: runBehaviorProbes ? undefined : previous?.runtime?.probes,
    });
    return { previousRuntime: previous?.runtime ?? null, currentRuntime };
  }
  const [previousRuntime, currentRuntime] = await Promise.all([
    previousVersion
      ? captureClaudeRuntime({
          version: previousVersion,
          tempDir: tmpdir(),
          requireAuth: true,
        })
      : Promise.resolve(null),
    captureClaudeRuntime({
      version: candidate.version,
      tempDir: tmpdir(),
      requireAuth: true,
    }),
  ]);
  return { previousRuntime, currentRuntime };
}

function buildErrorAnalysis(
  error: unknown,
  state: ClaudeWatchStateSnapshot | null,
): ClaudeWatchAnalysis {
  const message = error instanceof Error ? error.message : String(error);
  const candidate = state
    ? releaseForState(state)
    : {
        version: "unknown",
        published_at: new Date(0).toISOString(),
        integrity: "unknown",
        tarball_url: "",
        release_url: "https://github.com/anthropics/claude-code/releases",
        release_notes_md: "",
        release_published_at: new Date(0).toISOString(),
        dist_tags: { latest: "unknown", stable: null, next: null },
      };
  const docs = state?.docs ?? {
    index_url: "https://code.claude.com/docs/llms.txt",
    index_hash: "unknown",
    digest: "unknown",
    full_scan: false,
    scanned_at: new Date(0).toISOString(),
    pages: {},
  };
  const analysis = analyzeClaudeCandidate({
    candidate,
    previous: state,
    currentDocs: docs,
    currentRuntime: state?.runtime ?? null,
    workflowRunUrl: workflowRunUrl(),
    stateBaseSha: state?.state_commit_parent ?? null,
    errors: [message],
  });
  return {
    ...analysis,
    candidate_id: `${state?.candidate_id ?? "claude@unknown"}:error:${sha256(message).slice(0, 12)}`,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (
    (args.previousVersion || args.currentVersion) &&
    !args.dryRun &&
    !args.validationOnly
  ) {
    throw new Error(
      "Manual version overrides require --dry-run or --validation-only so historical replays cannot advance durable watcher state.",
    );
  }
  const repoPath = process.cwd();
  if (args.rebuildStateCommit) {
    const rebuilt = rebuildClaudeAnalysisFromState(
      repoPath,
      args.rebuildStateCommit,
    );
    writeAnalysis(args.analysisFile, rebuilt);
    console.log(JSON.stringify(rebuilt, null, 2));
    return;
  }

  const tracker = ensureTracker(args.repo, args.dryRun || args.validationOnly);
  trackerOutputs(tracker);
  const stateTip = args.validationOnly ? null : fetchStateBranchTip(repoPath);
  const state = stateTip ? loadStateSnapshotAtCommit(repoPath, stateTip) : null;
  if (stateTip && !state) {
    throw new Error(`Invalid Claude state snapshot at ${stateTip}`);
  }
  const probeContractStale = state?.runtime
    ? !isClaudeProbeContractCurrent(state.runtime)
    : false;
  const stateContractStale =
    state !== null &&
    state.schema_version !== CLAUDE_WATCH_STATE_SCHEMA_VERSION;
  const comparisonBaselineStale = probeContractStale || stateContractStale;

  if (
    !args.validationOnly &&
    stateTip &&
    state &&
    !comparisonBaselineStale &&
    !hasProcessedCandidate(tracker.state, state.candidate_id)
  ) {
    const analysis = rebuildClaudeAnalysisFromState(repoPath, stateTip);
    writeAnalysis(args.analysisFile, analysis);
    if (analysis.verdict === "no-op" && !args.dryRun) {
      const updated = recordTrackerOutcome(
        args.repo,
        tracker,
        analysis,
        "recorded_noop",
        "reconciled finalized no-op state after a partial run",
        stateTip,
      );
      trackerOutputs(updated);
      analysisOutputs(analysis, false, stateTip);
    } else {
      analysisOutputs(analysis, !args.dryRun, stateTip);
    }
    return;
  }

  if (!args.validationOnly && state && stateTip) {
    const entry = findTrackerEntry(tracker.state, state.candidate_id);
    if (
      entry &&
      isTerminalOutcome(entry.outcome) &&
      entry.state_commit_sha !== stateTip
    ) {
      if (!args.dryRun) {
        recordTrackerOutcome(
          args.repo,
          tracker,
          rebuildClaudeAnalysisFromState(repoPath, stateTip),
          entry.outcome,
          entry.notes,
          stateTip,
        );
      }
    }
  }

  let analysis: ClaudeWatchAnalysis;
  let docsCapture: CapturedDocs;
  let currentRuntime: ClaudeRuntimeSnapshot | null;
  let previousForAnalysis = state;
  try {
    const candidate = await selectCandidate(state, args);
    const packageChanged = state?.package_version !== candidate.version;
    docsCapture = await captureDocsSnapshot({
      previous: state?.docs ?? null,
      forceFullScan: args.forceDocsScan,
      packageRelease: packageChanged,
    });
    const docsChanged = docsCapture.snapshot.digest !== state?.docs.digest;
    const runtime = await captureRuntimePair(
      candidate,
      state,
      args,
      packageChanged ||
        docsChanged ||
        !state?.runtime ||
        comparisonBaselineStale,
    );
    currentRuntime = runtime.currentRuntime;
    if (comparisonBaselineStale) {
      previousForAnalysis = null;
    } else if (args.previousVersion && runtime.previousRuntime) {
      previousForAnalysis = {
        schema_version: 1,
        candidate_id: `manual-replay@${args.previousVersion}`,
        package_version: args.previousVersion,
        npm_integrity: "manual-replay",
        npm_published_at: candidate.published_at,
        release_url: candidate.release_url,
        release_notes_md: "manual replay baseline",
        release_published_at: candidate.release_published_at,
        dist_tags: candidate.dist_tags,
        docs: docsCapture.snapshot,
        runtime: runtime.previousRuntime,
        fetched_at: new Date().toISOString(),
        workflow_run_url: workflowRunUrl(),
        state_commit_parent: null,
      };
    } else if (state && runtime.previousRuntime) {
      previousForAnalysis = { ...state, runtime: runtime.previousRuntime };
    }
    analysis = analyzeClaudeCandidate({
      candidate,
      previous: previousForAnalysis,
      currentDocs: docsCapture.snapshot,
      previousSources: comparisonBaselineStale
        ? {}
        : stateSources(repoPath, stateTip),
      currentSources: docsCapture.sources,
      currentRuntime,
      workflowRunUrl: workflowRunUrl(),
      stateBaseSha: comparisonBaselineStale ? null : stateTip,
    });
  } catch (error) {
    analysis = buildErrorAnalysis(error, state);
    writeAnalysis(args.analysisFile, analysis);
    analysisOutputs(analysis, false, null);
    if (!args.dryRun && !args.validationOnly) {
      recordTrackerOutcome(
        args.repo,
        tracker,
        analysis,
        "error",
        "retryable detector error; state was not advanced",
        null,
        analysis.errors[0] ?? "unknown detector error",
      );
    }
    throw error;
  }

  writeAnalysis(args.analysisFile, analysis);
  if (args.validationOnly) {
    analysisOutputs(analysis, false, null);
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }
  if (state?.candidate_id === analysis.candidate_id) {
    analysisOutputs(analysis, false, stateTip);
    return;
  }
  if (hasProcessedCandidate(tracker.state, analysis.candidate_id)) {
    const entry = findTrackerEntry(tracker.state, analysis.candidate_id);
    if (args.dryRun || !entry) {
      analysisOutputs(analysis, false, entry?.state_commit_sha ?? stateTip);
      return;
    }
    const snapshot = buildClaudeStateSnapshot(
      analysis,
      docsCapture.snapshot,
      currentRuntime,
    );
    const finalized = finalizeStateBranch({
      repoPath,
      snapshot,
      files: docsCapture.sources,
      expectedBaseSha: stateTip,
    });
    recordTrackerOutcome(
      args.repo,
      tracker,
      analysis,
      entry.outcome,
      entry.notes,
      finalized.commitSha,
    );
    analysisOutputs(analysis, false, finalized.commitSha);
    return;
  }
  if (args.dryRun) {
    analysisOutputs(analysis, false, null);
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  const snapshot = buildClaudeStateSnapshot(
    analysis,
    docsCapture.snapshot,
    currentRuntime,
  );
  let finalized: ReturnType<typeof finalizeStateBranch>;
  try {
    finalized = finalizeStateBranch({
      repoPath,
      snapshot,
      files: docsCapture.sources,
      expectedBaseSha: stateTip,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAnalysis: ClaudeWatchAnalysis = {
      ...analysis,
      verdict: "manual review required",
      verdict_reasons: [`state finalization failed: ${message}`],
      errors: [...analysis.errors, message],
    };
    writeAnalysis(args.analysisFile, failedAnalysis);
    recordTrackerOutcome(
      args.repo,
      tracker,
      failedAnalysis,
      "error",
      "retryable state finalization error; durable state was not advanced",
      null,
      message,
    );
    throw error;
  }
  if (analysis.verdict === "no-op") {
    const updated = recordTrackerOutcome(
      args.repo,
      tracker,
      analysis,
      "recorded_noop",
      analysis.verdict_reasons.join("; "),
      finalized.commitSha,
    );
    trackerOutputs(updated);
    analysisOutputs(analysis, false, finalized.commitSha);
    return;
  }
  analysisOutputs(analysis, true, finalized.commitSha);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
