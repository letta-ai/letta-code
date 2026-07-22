/**
 * Shared contracts for `letta trajectories` — exporting historical coding-agent
 * sessions (Claude Code, Codex, and every other harness supported by
 * `@letta-ai/trajectory`) into a single directory of normalized trajectory-v1
 * files for downstream review (memory init, reflection). Discovery and
 * normalization both come from the trajectory package; this feature only
 * orchestrates them and indexes the results.
 */

/** Per-session entry in the export manifest. */
export interface SessionManifestEntry {
  source: string;
  id: string;
  /** Path of the normalized trajectory file, relative to the export dir. */
  file: string;
  /** Native store location this session was exported from. */
  sourcePath: string;
  /** Working directory recorded in the session meta, when available. */
  project?: string;
  /** Model recorded in the session meta, when available. */
  model?: string;
  startedAt?: string;
  endedAt?: string;
  records: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  reasoningRecords: number;
  /** Opening of the first user message, for skimming without opening the file. */
  firstUserPrompt?: string;
  /** Size of the normalized trajectory file in bytes. */
  bytes: number;
  diagnostics: number;
}

export interface TrajectoryExportError {
  source: string;
  sourcePath: string;
  error: string;
}

/** `manifest.json` written at the root of the export directory. */
export interface TrajectoryManifest {
  version: 1;
  generatedAt: string;
  outDir: string;
  /** Discovery/export counts per source that was scanned. */
  sources: Record<string, { discovered: number; exported: number }>;
  errors: TrajectoryExportError[];
  sessions: SessionManifestEntry[];
  /** Relative paths of worker chunk files, when `--chunks` was requested. */
  chunks?: string[];
}
