import {
  mkdir,
  readdir,
  readFile,
  rename,
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
import type {
  SessionManifestEntry,
  TrajectoryManifest,
} from "@/cli/subcommands/trajectories/types";

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
  /** Also partition sessions into this many worker chunk files. */
  chunks?: number;
  bounds?: NormalizationBounds;
  onProgress?: (message: string) => void;
}

const MANIFEST_NAME = "manifest.json";
const CHUNKS_DIR = "chunks";
const FIRST_PROMPT_MAX_CHARS = 200;
const LIST_PAGE_LIMIT = 1000;

/** Filesystem-safe filename stamp from an ISO startedAt (colons stripped). */
export function fileTimestamp(startedAt: string | undefined): string {
  if (!startedAt) return "unknown-date";
  return startedAt.slice(0, 19).replace(/:/g, "-");
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
 * Balance sessions across `count` chunks by normalized size (greedy
 * largest-first bin packing) so parallel workers get comparable workloads.
 */
export function partitionSessions(
  sessions: SessionManifestEntry[],
  count: number,
): SessionManifestEntry[][] {
  const bins = Array.from(
    { length: Math.max(1, Math.min(count, Math.max(sessions.length, 1))) },
    () => ({ bytes: 0, sessions: [] as SessionManifestEntry[] }),
  );
  const bySize = [...sessions].sort((a, b) => b.bytes - a.bytes);
  for (const session of bySize) {
    const target = bins.reduce((smallest, bin) =>
      bin.bytes < smallest.bytes ? bin : smallest,
    );
    target.sessions.push(session);
    target.bytes += session.bytes;
  }
  return bins.filter((bin) => bin.sessions.length > 0).map((b) => b.sessions);
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

  // Session files get uniform chronological names (<startedAt>_<index>.json)
  // whose index is only known once every session has been collected, so write
  // under a temporary name first and rename after the final sort. Native
  // session identity stays on the manifest entry's `id`.
  let pendingSeq = 0;
  const writeSession = async (
    source: string,
    id: string,
    sourcePath: string,
    records: NormalizedRecord[],
    diagnosticsCount: number,
    counts: { discovered: number; exported: number },
  ): Promise<void> => {
    const stats = collectStats(records);
    if (options.project && !(stats.project ?? "").startsWith(options.project)) {
      return;
    }
    pendingSeq += 1;
    const file = join(source, `.pending-${pendingSeq}.json`);
    const body = JSON.stringify(records);
    await mkdir(join(options.outDir, source), { recursive: true });
    await writeFile(join(options.outDir, file), body, "utf-8");
    counts.exported += 1;
    manifest.sessions.push({
      source,
      id,
      file,
      sourcePath,
      ...stats,
      records: records.length,
      bytes: Buffer.byteLength(body),
      diagnostics: diagnosticsCount,
    });
  };

  const sourceCounts = (source: string) => {
    const counts = manifest.sources[source] ?? { discovered: 0, exported: 0 };
    manifest.sources[source] = counts;
    return counts;
  };

  const exportCheckpoint = async (
    checkpoint: DeepAgentsCheckpointRef,
    id: string,
  ): Promise<void> => {
    const counts = sourceCounts(CHECKPOINT_SOURCE);
    counts.discovered += 1;
    const sourcePath = `${checkpoint.path}#${checkpoint.threadId}`;
    try {
      const { records, diagnostics } = await normalizeCheckpoint({
        source: CHECKPOINT_SOURCE,
        checkpoint: { path: checkpoint.path, threadId: checkpoint.threadId },
        bounds: options.bounds,
      });
      await writeSession(
        CHECKPOINT_SOURCE,
        id,
        sourcePath,
        records,
        diagnostics.length,
        counts,
      );
    } catch (error) {
      manifest.errors.push({
        source: CHECKPOINT_SOURCE,
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const exportTranscript = async (
    source: string,
    id: string,
    sourcePath: string,
    load: () => Promise<string>,
  ): Promise<void> => {
    const counts = sourceCounts(source);
    counts.discovered += 1;
    try {
      const { records, diagnostics } = normalizeTranscript({
        source: source as TranscriptTrajectorySource,
        transcript: await load(),
        bounds: options.bounds,
      });
      await writeSession(
        source,
        id,
        sourcePath,
        records,
        diagnostics.length,
        counts,
      );
    } catch (error) {
      manifest.errors.push({
        source,
        sourcePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

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

  // Assign the final uniform filenames: <startedAt>_<index>.json, where the
  // 1-based index is the session's position in the chronologically sorted
  // manifest. Identical across sources, unique by construction, and `ls`
  // within a source folder lists sessions in time order.
  const width = Math.max(4, String(manifest.sessions.length).length);
  for (const [index, session] of manifest.sessions.entries()) {
    const file = join(
      session.source,
      `${fileTimestamp(session.startedAt)}_${String(index + 1).padStart(width, "0")}.json`,
    );
    await rename(
      join(options.outDir, session.file),
      join(options.outDir, file),
    );
    session.file = file;
  }

  if (options.chunks && options.chunks > 0 && manifest.sessions.length > 0) {
    const partitions = partitionSessions(manifest.sessions, options.chunks);
    await mkdir(join(options.outDir, CHUNKS_DIR), { recursive: true });
    manifest.chunks = [];
    for (const [index, sessions] of partitions.entries()) {
      const name = `chunk-${String(index + 1).padStart(2, "0")}.json`;
      const file = join(CHUNKS_DIR, name);
      await writeFile(
        join(options.outDir, file),
        JSON.stringify(
          { chunk: index + 1, outDir: options.outDir, sessions },
          null,
          2,
        ),
        "utf-8",
      );
      manifest.chunks.push(file);
    }
  }

  await writeFile(
    join(options.outDir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  return manifest;
}
