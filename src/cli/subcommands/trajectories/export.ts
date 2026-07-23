import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AnyTrajectorySource,
  listTrajectories,
  type NormalizationBounds,
  type NormalizedRecord,
  type NormalizeResult,
  normalizeCheckpoint,
  normalizeTranscript,
  type TrajectoryListing,
  type TranscriptTrajectorySource,
} from "@letta-ai/trajectory";
import { loadSessionTranscript } from "@/cli/subcommands/trajectories/readers";
import {
  CHECKPOINT_SOURCE,
  listSupportedSources,
} from "@/cli/subcommands/trajectories/sources";
import type { TrajectoryManifest } from "@/cli/subcommands/trajectories/types";

export interface ExplicitTranscript {
  source: string;
  path: string;
}

export interface DeepAgentsCheckpointRef {
  path: string;
  threadId: string;
}

export interface TrajectoryExportOptions {
  outDir: string;
  /** Restrict discovery to these sources. Default: every supported source. */
  sources?: string[];
  /** Per-source store-root overrides (`--root <source>:<path>`). */
  roots?: Record<string, string>;
  /** Explicit `--transcript <source>:<path>` transcripts to include. */
  transcripts?: ExplicitTranscript[];
  /** Extra Deep Agents checkpoints (`--deepagents <db>:<thread-id>`). */
  deepagents?: DeepAgentsCheckpointRef[];
  /** Keep only sessions whose recorded working directory starts with this path. */
  project?: string;
  bounds?: NormalizationBounds;
  onProgress?: (message: string) => void;
}

const MANIFEST_NAME = "manifest.json";
const FIRST_PROMPT_MAX_CHARS = 200;
const LIST_PAGE_LIMIT = 1000;

/** Filesystem-safe filename stamp from an ISO startedAt (colons stripped). */
export function fileTimestamp(startedAt: string | undefined): string {
  if (!startedAt) return "unknown-date";
  return startedAt.slice(0, 19).replace(/:/g, "-");
}

/**
 * Stable session identifier: sha256 of the source-scoped native session id,
 * shortened to 10 hex chars. Unlike a positional index, it does not change
 * when other sessions appear or disappear between exports, so it can be used
 * to track which sessions have already been processed.
 */
export function sessionHash(source: string, nativeId: string): string {
  return createHash("sha256")
    .update(`${source}:${nativeId}`)
    .digest("hex")
    .slice(0, 10);
}

/**
 * Page through `listTrajectories` and return every session in the source's
 * local store. A missing store yields an empty list rather than an error.
 */
export async function listAllTrajectories(
  source: string,
  root: string | undefined,
): Promise<TrajectoryListing[]> {
  const items: TrajectoryListing[] = [];
  let cursor: string | undefined;
  do {
    const page = await listTrajectories({
      source: source as AnyTrajectorySource,
      root,
      cursor,
      limit: LIST_PAGE_LIMIT,
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

interface SessionStats {
  project?: string;
  model?: string;
  startedAt?: string;
  endedAt?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  reasoningRecords: number;
  firstUserPrompt?: string;
}

function collectStats(records: NormalizedRecord[]): SessionStats {
  const stats: SessionStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    reasoningRecords: 0,
  };
  for (const record of records) {
    if (record.role === "meta") {
      stats.project = record.cwd;
      stats.model = record.model;
      continue;
    }
    if (!stats.startedAt && record.timestamp) {
      stats.startedAt = record.timestamp;
    }
    if (record.timestamp) {
      stats.endedAt = record.timestamp;
    }
    if (record.role === "user") {
      stats.userMessages += 1;
      if (stats.firstUserPrompt === undefined) {
        stats.firstUserPrompt = record.content.slice(0, FIRST_PROMPT_MAX_CHARS);
      }
    } else if (record.role === "assistant") {
      stats.assistantMessages += 1;
      if ("tool_calls" in record) {
        stats.toolCalls += record.tool_calls.length;
      }
    } else if (record.role === "reasoning") {
      stats.reasoningRecords += 1;
    }
  }
  return stats;
}

/**
 * Prepare the output directory. Refuses to reuse a non-empty directory that
 * was not produced by a previous export (no manifest), so a typo in `--out`
 * cannot clobber unrelated files; previous export content is replaced.
 */
async function prepareOutDir(outDir: string): Promise<void> {
  try {
    const existing = await stat(outDir);
    if (!existing.isDirectory()) {
      throw new Error(`--out ${outDir} exists and is not a directory`);
    }
    const entries = await readdir(outDir);
    if (entries.length > 0 && !entries.includes(MANIFEST_NAME)) {
      throw new Error(
        `--out ${outDir} is not empty and has no ${MANIFEST_NAME}; refusing to overwrite a directory this tool did not create`,
      );
    }
    for (const entry of entries) {
      await rm(join(outDir, entry), { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(outDir, { recursive: true });
}

/**
 * Default store-root override for the letta source: the trajectory lister only
 * knows the standard `~/.letta/lc-local-backend` location, so honor this CLI's
 * `LETTA_LOCAL_BACKEND_DIR` env override when the caller has not pinned a root.
 */
function lettaRootFromEnv(): string | undefined {
  const dir = process.env.LETTA_LOCAL_BACKEND_DIR;
  return dir ? join(dir, "conversations") : undefined;
}

export async function runTrajectoryExport(
  options: TrajectoryExportOptions,
): Promise<TrajectoryManifest> {
  const progress = options.onProgress ?? (() => {});
  const supported = await listSupportedSources();

  const requested = options.sources?.length ? options.sources : supported;
  for (const source of requested) {
    if (!supported.includes(source)) {
      throw new Error(
        `Unknown source "${source}". The installed trajectory package supports: ${supported.join(", ")}.`,
      );
    }
  }

  await prepareOutDir(options.outDir);

  const manifest: TrajectoryManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    outDir: options.outDir,
    sources: {},
    errors: [],
    sessions: [],
  };

  const sourceCounts = (source: string) => {
    const counts = manifest.sources[source] ?? { discovered: 0, exported: 0 };
    manifest.sources[source] = counts;
    return counts;
  };

  // Filenames are <startedAt>_<sessionId>.json: the timestamp keeps `ls`
  // chronological within a source folder, and the hashed native id makes the
  // name stable across re-exports regardless of what other sessions exist.
  // Collisions (same source, same native id — e.g. two --transcript files
  // with the same basename) get a numeric suffix.
  const usedFiles = new Set<string>();
  const exportSession = async (
    source: string,
    id: string,
    sourcePath: string,
    normalize: () => Promise<NormalizeResult> | NormalizeResult,
  ): Promise<void> => {
    const counts = sourceCounts(source);
    counts.discovered += 1;
    try {
      const { records, diagnostics } = await normalize();
      const stats = collectStats(records);
      if (
        options.project &&
        !(stats.project ?? "").startsWith(options.project)
      ) {
        return;
      }
      const sessionId = sessionHash(source, id);
      const base = `${fileTimestamp(stats.startedAt)}_${sessionId}`;
      let file = join(source, `${base}.json`);
      for (let suffix = 2; usedFiles.has(file); suffix += 1) {
        file = join(source, `${base}-${suffix}.json`);
      }
      usedFiles.add(file);
      const body = JSON.stringify(records);
      await mkdir(join(options.outDir, source), { recursive: true });
      await writeFile(join(options.outDir, file), body, "utf-8");
      counts.exported += 1;
      manifest.sessions.push({
        source,
        id,
        sessionId,
        file,
        sourcePath,
        ...stats,
        records: records.length,
        bytes: Buffer.byteLength(body),
        diagnostics: diagnostics.length,
      });
    } catch (error) {
      manifest.errors.push({
        source,
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const exportCheckpoint = (checkpoint: DeepAgentsCheckpointRef, id: string) =>
    exportSession(
      CHECKPOINT_SOURCE,
      id,
      `${checkpoint.path}#${checkpoint.threadId}`,
      () =>
        normalizeCheckpoint({
          source: CHECKPOINT_SOURCE,
          checkpoint: { path: checkpoint.path, threadId: checkpoint.threadId },
          bounds: options.bounds,
        }),
    );

  const exportTranscript = (
    source: string,
    id: string,
    sourcePath: string,
    load: () => Promise<string>,
  ) =>
    exportSession(source, id, sourcePath, async () =>
      normalizeTranscript({
        source: source as TranscriptTrajectorySource,
        transcript: await load(),
        bounds: options.bounds,
      }),
    );

  for (const source of requested) {
    const root =
      options.roots?.[source] ??
      (source === "letta" ? lettaRootFromEnv() : undefined);
    const items = await listAllTrajectories(source, root);
    sourceCounts(source);
    progress(`${source}: found ${items.length} session(s)`);
    for (const item of items) {
      if (source === CHECKPOINT_SOURCE) {
        await exportCheckpoint({ path: item.path, threadId: item.id }, item.id);
      } else {
        await exportTranscript(source, item.id, item.path, () =>
          loadSessionTranscript(item),
        );
      }
    }
  }

  for (const explicit of options.transcripts ?? []) {
    if (!supported.includes(explicit.source)) {
      throw new Error(
        `Unknown source "${explicit.source}" in --transcript. The installed trajectory package supports: ${supported.join(", ")}.`,
      );
    }
    await exportTranscript(
      explicit.source,
      basename(explicit.path).replace(/\.[^.]+$/, ""),
      explicit.path,
      () => readFile(explicit.path, "utf-8"),
    );
  }

  for (const checkpoint of options.deepagents ?? []) {
    await exportCheckpoint(
      checkpoint,
      `${basename(checkpoint.path)}-${checkpoint.threadId}`,
    );
  }

  manifest.sessions.sort((a, b) =>
    (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
  );

  await writeFile(
    join(options.outDir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  return manifest;
}
