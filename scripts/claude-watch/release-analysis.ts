import { diffDocsSnapshots } from "./docs-snapshot.ts";
import { diffClaudeRuntime } from "./runtime-probe.ts";
import {
  loadStateFilesAtCommit,
  loadStateSnapshotAtCommit,
} from "./state-branch.ts";
import {
  CLAUDE_WATCH_STATE_SCHEMA_VERSION,
  type ClaudeDocsSnapshot,
  type ClaudeReleaseCandidate,
  type ClaudeRuntimeSnapshot,
  type ClaudeWatchAnalysis,
  type ClaudeWatchStateSnapshot,
  type ClaudeWatchVerdict,
} from "./types.ts";

export interface AnalyzeClaudeCandidateOptions {
  candidate: ClaudeReleaseCandidate;
  previous: ClaudeWatchStateSnapshot | null;
  currentDocs: ClaudeDocsSnapshot;
  previousSources?: Record<string, string>;
  currentSources?: Record<string, string>;
  currentRuntime: ClaudeRuntimeSnapshot | null;
  workflowRunUrl: string;
  stateBaseSha: string | null;
  errors?: string[];
}

export interface ClaudeVerdictInput {
  analysis: Omit<ClaudeWatchAnalysis, "verdict" | "verdict_reasons">;
}

export function buildClaudeCandidateId(
  version: string,
  docsDigest: string,
  runtimeDigest: string | null = null,
): string {
  return `claude@${version}:docs:${docsDigest}:runtime:${runtimeDigest ?? "none"}`;
}

export function buildClaudeStateSnapshot(
  analysis: ClaudeWatchAnalysis,
  docs: ClaudeDocsSnapshot,
  runtime: ClaudeRuntimeSnapshot | null,
): ClaudeWatchStateSnapshot {
  return {
    schema_version: CLAUDE_WATCH_STATE_SCHEMA_VERSION,
    candidate_id: analysis.candidate_id,
    package_version: analysis.current_version,
    npm_integrity: analysis.npm_integrity,
    npm_published_at: analysis.npm_published_at,
    release_url: analysis.release_url,
    release_notes_md: analysis.release_notes_md,
    release_published_at: analysis.release_published_at,
    dist_tags: analysis.dist_tags,
    docs,
    runtime,
    fetched_at: new Date().toISOString(),
    workflow_run_url: analysis.workflow_run_url,
    state_commit_parent: analysis.state_base_sha,
    analysis_parent_sha: analysis.state_base_sha,
  };
}

export function analyzeClaudeCandidate(
  options: AnalyzeClaudeCandidateOptions,
): ClaudeWatchAnalysis {
  const docsDiff = diffDocsSnapshots(
    options.previous?.docs ?? null,
    options.currentDocs,
    {
      previousSources: options.previousSources,
      currentSources: options.currentSources,
    },
  );
  const runtimeDiff =
    options.previous?.runtime && options.currentRuntime
      ? diffClaudeRuntime(options.previous.runtime, options.currentRuntime)
      : null;
  const candidateId = buildClaudeCandidateId(
    options.candidate.version,
    options.currentDocs.digest,
    options.currentRuntime?.digest ?? null,
  );
  const base = {
    schema_version: 1,
    candidate_id: candidateId,
    previous_candidate_id: options.previous?.candidate_id ?? null,
    previous_version: options.previous?.package_version ?? null,
    current_version: options.candidate.version,
    is_bootstrap: options.previous === null,
    release_url: options.candidate.release_url,
    release_notes_md: options.candidate.release_notes_md,
    npm_integrity: options.candidate.integrity,
    npm_published_at: options.candidate.published_at,
    release_published_at: options.candidate.release_published_at,
    dist_tags: options.candidate.dist_tags,
    docs_digest: options.currentDocs.digest,
    runtime_digest: options.currentRuntime?.digest ?? null,
    docs_diff: docsDiff,
    previous_runtime_snapshot: options.previous?.runtime ?? null,
    runtime_snapshot: options.currentRuntime,
    runtime_diff: runtimeDiff,
    errors: options.errors ?? [],
    workflow_run_url: options.workflowRunUrl,
    state_base_sha: options.stateBaseSha,
    state_snapshot_candidate_id: options.previous?.candidate_id ?? null,
  } satisfies Omit<ClaudeWatchAnalysis, "verdict" | "verdict_reasons">;
  const { verdict, reasons } = classifyClaudeVerdict({ analysis: base });
  return {
    ...base,
    verdict,
    verdict_reasons: reasons,
  };
}

export function rebuildClaudeAnalysisFromState(
  repoPath: string,
  stateCommitSha: string,
): ClaudeWatchAnalysis {
  const current = loadStateSnapshotAtCommit(repoPath, stateCommitSha);
  if (!current) {
    throw new Error(`No valid Claude state snapshot at ${stateCommitSha}`);
  }
  const analysisParentSha =
    current.analysis_parent_sha === undefined
      ? current.state_commit_parent
      : current.analysis_parent_sha;
  const previous = analysisParentSha
    ? loadStateSnapshotAtCommit(repoPath, analysisParentSha)
    : null;
  const currentFiles = loadStateFilesAtCommit(repoPath, stateCommitSha);
  const previousFiles = analysisParentSha
    ? loadStateFilesAtCommit(repoPath, analysisParentSha)
    : {};
  const candidate: ClaudeReleaseCandidate = {
    version: current.package_version,
    published_at: current.npm_published_at,
    integrity: current.npm_integrity,
    tarball_url: "",
    release_url: current.release_url,
    release_notes_md: current.release_notes_md,
    release_published_at: current.release_published_at,
    dist_tags: current.dist_tags,
  };
  const analysis = analyzeClaudeCandidate({
    candidate,
    previous,
    currentDocs: current.docs,
    previousSources: sourceFiles(previousFiles),
    currentSources: sourceFiles(currentFiles),
    currentRuntime: current.runtime,
    workflowRunUrl: current.workflow_run_url,
    stateBaseSha: analysisParentSha,
  });
  if (analysis.candidate_id !== current.candidate_id) {
    throw new Error(
      `Rebuilt candidate ${analysis.candidate_id} does not match state ${current.candidate_id}`,
    );
  }
  return analysis;
}

function sourceFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).filter(([path]) => path.startsWith("sources/")),
  );
}

export function classifyClaudeVerdict(input: ClaudeVerdictInput): {
  verdict: ClaudeWatchVerdict;
  reasons: string[];
} {
  const { analysis } = input;
  const reasons: string[] = [];
  if (analysis.errors.length > 0) {
    return {
      verdict: "manual review required",
      reasons: analysis.errors.map((error) => `capture error: ${error}`),
    };
  }
  if (analysis.is_bootstrap) {
    return {
      verdict: "manual review required",
      reasons: [
        "bootstrap requires a complete current Claude-vs-local parity audit",
      ],
    };
  }

  const runtime = analysis.runtime_diff;
  if (
    runtime &&
    (runtime.tools_added.length > 0 || runtime.tools_removed.length > 0)
  ) {
    reasons.push(
      `runtime tool inventory changed (${[
        ...runtime.tools_added.map((name) => `+${name}`),
        ...runtime.tools_removed.map((name) => `-${name}`),
      ].join(", ")})`,
    );
    return { verdict: "tool surface review needed", reasons };
  }

  const namedToolChanges = analysis.docs_diff.tools;
  const probeProblems = [
    ...(analysis.previous_runtime_snapshot?.probes.map((probe) => ({
      side: "previous",
      probe,
    })) ?? []),
    ...(analysis.runtime_snapshot?.probes.map((probe) => ({
      side: "current",
      probe,
    })) ?? []),
  ].filter(({ probe }) => probe.status !== "passed");
  if (probeProblems.length > 0) {
    return {
      verdict: "manual review required",
      reasons: probeProblems.map(
        ({ side, probe }) =>
          `${side} ${probe.name} probe was ${probe.status}: ${probe.error ?? "unknown"}`,
      ),
    };
  }
  if (
    namedToolChanges.added.length > 0 ||
    namedToolChanges.removed.length > 0 ||
    namedToolChanges.changed.length > 0 ||
    (runtime?.changed_probes.length ?? 0) > 0
  ) {
    reasons.push("official tool contracts or fixed probe observations changed");
    return { verdict: "tool contract review needed", reasons };
  }

  const releaseText = analysis.release_notes_md.toLowerCase();
  if (
    /\b(system prompt|prompt instruction|claude\.md|memory|output style|model guidance)\b/u.test(
      releaseText,
    )
  ) {
    return {
      verdict: "prompt review needed",
      reasons: [
        "release notes describe model-facing prompt or guidance behavior",
      ],
    };
  }

  const docs = analysis.docs_diff;
  const watchedDocsChanged = docs.watched_page_diffs.length > 0;
  const anyDocsPageChanged =
    docs.added_pages.length > 0 ||
    docs.removed_pages.length > 0 ||
    docs.changed_pages.length > 0;
  const namedHarnessChanged = [
    docs.cli,
    docs.settings,
    docs.env_vars,
    docs.permission_rules,
  ].some(
    (change) =>
      change.added.length > 0 ||
      change.removed.length > 0 ||
      change.changed.length > 0,
  );
  const runtimeChanged = Boolean(
    runtime &&
      (runtime.help_changed ||
        runtime.doctor_changed ||
        runtime.init_changed ||
        runtime.auto_mode_defaults_changed ||
        runtime.event_types_added.length > 0 ||
        runtime.event_types_removed.length > 0),
  );
  const packageChanged = analysis.previous_version !== analysis.current_version;
  if (
    watchedDocsChanged ||
    anyDocsPageChanged ||
    namedHarnessChanged ||
    runtimeChanged ||
    packageChanged
  ) {
    if (watchedDocsChanged) reasons.push("watched official docs changed");
    else if (anyDocsPageChanged)
      reasons.push("an unwatched official docs page changed and needs review");
    if (namedHarnessChanged) reasons.push("named harness surfaces changed");
    if (runtimeChanged) reasons.push("observable runtime behavior changed");
    if (packageChanged)
      reasons.push("a new exact Claude package was published");
    return { verdict: "harness behavior review needed", reasons };
  }

  return {
    verdict: "no-op",
    reasons: ["only unwatched documentation content or metadata changed"],
  };
}
