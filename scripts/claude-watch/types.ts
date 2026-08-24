export const CLAUDE_WATCH_STATE_SCHEMA_VERSION = 2;

export type ClaudeWatchVerdict =
  | "no-op"
  | "prompt review needed"
  | "tool contract review needed"
  | "tool surface review needed"
  | "harness behavior review needed"
  | "manual review required";

export type ClaudeWatchOutcome =
  | "recorded_noop"
  | "no_local_impact"
  | "pr_created"
  | "needs_human_review"
  | "error";

export interface ClaudeGitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  body: string | null;
  published_at: string | null;
}

export interface ClaudeNpmVersion {
  version: string;
  published_at: string;
  integrity: string;
  tarball_url: string;
}

export interface ClaudeNpmMetadata {
  dist_tags: {
    latest: string;
    stable: string | null;
    next: string | null;
  };
  versions: ClaudeNpmVersion[];
}

export interface ClaudeReleaseCandidate extends ClaudeNpmVersion {
  release_url: string;
  release_notes_md: string;
  release_published_at: string;
  dist_tags: ClaudeNpmMetadata["dist_tags"];
}

export interface ClaudeDocsPageSnapshot {
  url: string;
  hash: string;
  watched: boolean;
  source_path: string | null;
}

export interface ClaudeDocsSnapshot {
  index_url: string;
  index_hash: string;
  digest: string;
  full_scan: boolean;
  scanned_at: string;
  pages: Record<string, ClaudeDocsPageSnapshot>;
}

export interface ClaudeNamedChange {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface ClaudeDocsPageDiff {
  url: string;
  source_path: string | null;
  preview: string;
  truncated: boolean;
}

export interface ClaudeDocsDiff {
  added_pages: string[];
  removed_pages: string[];
  changed_pages: string[];
  watched_page_diffs: ClaudeDocsPageDiff[];
  tools: ClaudeNamedChange;
  cli: ClaudeNamedChange;
  settings: ClaudeNamedChange;
  env_vars: ClaudeNamedChange;
  permission_rules: ClaudeNamedChange;
}

export interface ClaudeProbeObservation {
  name: string;
  status: "passed" | "inconclusive" | "failed" | "skipped";
  attempts: number;
  assertions: Record<string, boolean | string | null>;
  tool_calls: Array<{
    name: string;
    input: unknown;
  }>;
  tool_results: string[];
  filesystem_changes: string[];
  error: string | null;
}

export interface ClaudeRuntimeSnapshot {
  probe_contract_version: number;
  version: string;
  version_output: string;
  help_text: string;
  help_hash: string;
  doctor: {
    exit_code: number;
    summary: string;
  };
  auto_mode_defaults: unknown | null;
  init: {
    tools: string[];
    model: string | null;
    capabilities: unknown | null;
    stable_fields: Record<string, unknown>;
  } | null;
  event_inventory: string[];
  probes: ClaudeProbeObservation[];
  digest: string;
}

export interface ClaudeRuntimeDiff {
  tools_added: string[];
  tools_removed: string[];
  help_changed: boolean;
  help_lines_added: string[];
  help_lines_removed: string[];
  doctor_changed: boolean;
  init_changed: boolean;
  auto_mode_defaults_changed: boolean;
  event_types_added: string[];
  event_types_removed: string[];
  changed_probes: string[];
}

export interface ClaudeWatchStateSnapshot {
  schema_version: number;
  candidate_id: string;
  package_version: string;
  npm_integrity: string;
  npm_published_at: string;
  release_url: string;
  release_notes_md: string;
  release_published_at: string;
  dist_tags: ClaudeNpmMetadata["dist_tags"];
  docs: ClaudeDocsSnapshot;
  runtime: ClaudeRuntimeSnapshot | null;
  fetched_at: string;
  workflow_run_url: string;
  /** Physical parent on the durable state branch. */
  state_commit_parent: string | null;
  /** Snapshot used for semantic diffing; undefined legacy snapshots use the physical parent. */
  analysis_parent_sha?: string | null;
}

export interface ClaudeWatchAnalysis {
  schema_version: number;
  candidate_id: string;
  previous_candidate_id: string | null;
  previous_version: string | null;
  current_version: string;
  is_bootstrap: boolean;
  release_url: string;
  release_notes_md: string;
  npm_integrity: string;
  npm_published_at: string;
  release_published_at: string;
  dist_tags: ClaudeNpmMetadata["dist_tags"];
  docs_digest: string;
  runtime_digest: string | null;
  docs_diff: ClaudeDocsDiff;
  previous_runtime_snapshot: ClaudeRuntimeSnapshot | null;
  runtime_snapshot: ClaudeRuntimeSnapshot | null;
  runtime_diff: ClaudeRuntimeDiff | null;
  verdict: ClaudeWatchVerdict;
  verdict_reasons: string[];
  errors: string[];
  workflow_run_url: string;
  state_base_sha: string | null;
  state_snapshot_candidate_id: string | null;
}
