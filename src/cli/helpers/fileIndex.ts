import { createHash } from "node:crypto";
import type { Stats as FsStats } from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, normalize, relative, sep } from "node:path";
import { debugLog } from "../../utils/debug";
import { readIntSetting } from "../../utils/lettaSettings";
import { shouldExcludeEntry } from "./fileSearchConfig";

interface FileIndexEntry {
  path: string;
  type: "file" | "dir";
  lowerPath: string;
  parent: string;
}

interface SearchFileIndexOptions {
  searchDir: string;
  pattern: string;
  deep: boolean;
  maxResults: number;
}

interface FileStats {
  type: "file" | "dir";
  mtimeMs: number;
  ino: number;
  size?: number;
}

type StatsMap = Record<string, FileStats>;
type MerkleMap = Record<string, string>;

export interface FileMatch {
  path: string;
  type: "file" | "dir";
}

const MAX_INDEX_DEPTH = 12;
const PROJECT_INDEX_FILENAME = "file-index.json";

/**
 * Cache format version. Bump this whenever the on-disk format changes
 * in a backward-incompatible way (e.g. switching hash algorithm).
 *
 *   v1 (implicit) – metadata-based file hashes: sha256(path:size:mtime:ino)
 *   v2            – content-based file hashes:  sha256(file_bytes)
 */
const CACHE_VERSION = 2;

/**
 * Files larger than this threshold use a metadata-based hash instead of
 * reading the entire file for content hashing. This avoids expensive reads
 * on large binaries/assets while still content-hashing all normal source files.
 */
const MAX_CONTENT_HASH_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// Read from ~/.letta/.lettasettings (MAX_ENTRIES), falling back to 50 000.
// The file is auto-created with comments on first run so users can find it.
const MAX_CACHE_ENTRIES = readIntSetting("MAX_ENTRIES", 50_000);

// Maximum size of the index cache file before we skip loading it.
// Large cache files (e.g., 447MB for home directory) cause OOM when parsed.
// If the cache exceeds this threshold, we rebuild from scratch instead.
const MAX_CACHE_FILE_SIZE_MB = 50;

let cachedEntries: FileIndexEntry[] = [];
// Kept in sync with cachedEntries for O(1) membership checks in addEntriesToCache.
let cachedEntryPaths = new Set<string>();
let buildPromise: Promise<void> | null = null;
let hasCompletedBuild = false;

/**
 * The root directory that the file index is built from.  Defaults to
 * `process.cwd()` at module load time.  Use `setIndexRoot()` to point
 * it at a different directory without mutating global process state.
 */
let indexRoot: string = process.cwd();

interface FileIndexCache {
  metadata: {
    rootHash: string;
    /**
     * Cache format version.  `undefined` implies v1 (legacy metadata hashes).
     * When the on-disk version doesn't match CACHE_VERSION the cache is
     * discarded and rebuilt from scratch.
     */
    version?: number;
  };
  entries: FileIndexEntry[];
  merkle: MerkleMap;
  stats: StatsMap;
}

interface PreviousIndexData {
  entries: FileIndexEntry[];
  entryPaths: string[];
  merkle: MerkleMap;
  merkleKeys: string[];
  stats: StatsMap;
  statsKeys: string[];
}

interface BuildContext {
  newEntryCount: number;
  totalEntryCount: number; // Tracks all entries including reused ones
  truncated: boolean;
}

interface FileIndexBuildResult {
  entries: FileIndexEntry[];
  merkle: MerkleMap;
  stats: StatsMap;
  rootHash: string;
  truncated: boolean;
}

function normalizeParent(relativePath: string): string {
  if (relativePath.length === 0) {
    return "";
  }
  const lastSepIndex = relativePath.lastIndexOf(sep);
  return lastSepIndex === -1 ? "" : relativePath.slice(0, lastSepIndex);
}

function hashValue(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Compute a content-based hash for a file.
 *
 * For files at or below MAX_CONTENT_HASH_FILE_SIZE the hash is
 * `sha256(file_bytes)` — identical content on any device produces
 * the same hash, which is required for cross-device Merkle comparison.
 *
 * For larger files (binaries, assets) we fall back to a metadata-based
 * hash to avoid expensive reads.  These are prefixed with `meta:` so
 * the sync layer can identify files that need re-hashing later.
 */
function hashFile(
  fullPath: string,
  entryPath: string,
  stat: FsStats,
): string {
  if (stat.size > MAX_CONTENT_HASH_FILE_SIZE) {
    return hashValue(
      `meta:${entryPath}:${stat.size}:${stat.mtimeMs}:${stat.ino ?? 0}`,
    );
  }

  try {
    const content = readFileSync(fullPath);
    return createHash("sha256").update(content).digest("hex");
  } catch (err) {
    debugLog("file-index", `Cannot read file for hashing ${fullPath}: ${err}`);
    return hashValue(
      `meta:${entryPath}:${stat.size}:${stat.mtimeMs}:${stat.ino ?? 0}`,
    );
  }
}

function lowerBound(sorted: string[], target: string): number {
  let low = 0;
  let high = sorted.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? "") < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function findPrefixRange(sorted: string[], prefix: string): [number, number] {
  const start = lowerBound(sorted, prefix);
  let end = start;

  while (end < sorted.length) {
    const candidate = sorted[end];
    if (!candidate?.startsWith(prefix)) {
      break;
    }
    end++;
  }

  return [start, end];
}

function preparePreviousIndexData(cache: FileIndexCache): PreviousIndexData {
  const entryPaths = cache.entries.map((entry) => entry.path);
  const merkleKeys = Object.keys(cache.merkle).sort();
  const stats: StatsMap = { ...cache.stats };
  const statsKeys = Object.keys(stats).sort();

  return {
    entries: cache.entries,
    entryPaths,
    merkle: cache.merkle,
    merkleKeys,
    stats,
    statsKeys,
  };
}

function appendSubtreeEntries(
  targetEntries: FileIndexEntry[],
  previous: PreviousIndexData,
  path: string,
  context: BuildContext,
): void {
  // Don't copy if we've already hit the cap
  if (context.totalEntryCount >= MAX_CACHE_ENTRIES) {
    context.truncated = true;
    return;
  }

  if (path === "") {
    // Copy all entries up to cap
    const toCopy = previous.entries.slice(
      0,
      MAX_CACHE_ENTRIES - context.totalEntryCount,
    );
    for (const e of toCopy) {
      targetEntries.push(e);
      context.totalEntryCount++;
    }
    if (previous.entries.length > toCopy.length) {
      context.truncated = true;
    }
    return;
  }

  const { entryPaths, entries: previousEntries } = previous;
  // Do NOT push the directory's own entry here — the parent loop already did
  // that before making the recursive buildDirectory call. Only copy children.
  const prefix = `${path}/`;
  const [start, end] = findPrefixRange(entryPaths, prefix);

  let copied = 0;
  const maxToCopy = MAX_CACHE_ENTRIES - context.totalEntryCount;
  for (let i = start; i < end && copied < maxToCopy; i++) {
    const entry = previousEntries[i];
    if (entry !== undefined) {
      targetEntries.push(entry);
      context.totalEntryCount++;
      copied++;
    }
  }

  if (start + copied < end) {
    context.truncated = true;
  }
}

function copyMerkleSubtree(
  previous: PreviousIndexData,
  path: string,
  target: MerkleMap,
): void {
  if (path !== "" && previous.merkle[path]) {
    target[path] = previous.merkle[path];
  }

  const prefix = path === "" ? "" : `${path}/`;
  const [start, end] =
    prefix === ""
      ? [0, previous.merkleKeys.length]
      : findPrefixRange(previous.merkleKeys, prefix);

  for (let i = start; i < end; i++) {
    const key = previous.merkleKeys[i];
    if (key === undefined) continue;
    target[key] = previous.merkle[key] ?? "";
  }
}

function copyStatsSubtree(
  previous: PreviousIndexData,
  path: string,
  target: StatsMap,
): void {
  if (path !== "" && previous.stats[path]) {
    target[path] = previous.stats[path];
  }

  const prefix = path === "" ? "" : `${path}/`;
  const [start, end] =
    prefix === ""
      ? [0, previous.statsKeys.length]
      : findPrefixRange(previous.statsKeys, prefix);

  for (let i = start; i < end; i++) {
    const key = previous.statsKeys[i];
    if (key === undefined) continue;
    const val = previous.stats[key];
    if (val !== undefined) target[key] = val;
  }
}

function collectPreviousChildNames(
  previous: PreviousIndexData,
  path: string,
): Set<string> {
  const names = new Set<string>();
  const prefix = path === "" ? "" : `${path}/`;

  // Use binary search to jump to the relevant range instead of scanning all
  // statsKeys. For root (prefix="") every key qualifies so we start at 0;
  // for any other path findPrefixRange narrows it to O(log n + k).
  const [start, end] =
    prefix === ""
      ? [0, previous.statsKeys.length]
      : findPrefixRange(previous.statsKeys, prefix);

  for (let i = start; i < end; i++) {
    const key = previous.statsKeys[i];
    if (!key) {
      continue;
    }

    const remainder = key.slice(prefix.length);
    const slashIndex = remainder.indexOf("/");
    const childName =
      slashIndex === -1 ? remainder : remainder.slice(0, slashIndex);
    if (childName.length > 0) {
      names.add(childName);
    }
  }

  return names;
}

function statsMatch(prev: FileStats, current: FsStats): boolean {
  if (prev.type === "dir" && !current.isDirectory()) {
    return false;
  }

  if (prev.type === "file" && !current.isFile()) {
    return false;
  }

  if (prev.mtimeMs !== current.mtimeMs || prev.ino !== (current.ino ?? 0)) {
    return false;
  }

  if (prev.type === "file") {
    return typeof prev.size === "number" ? prev.size === current.size : true;
  }

  return true;
}

function shouldReuseDirectory(
  previous: PreviousIndexData | undefined,
  path: string,
  stats: FileStats,
  childNames: string[],
  childStats: Map<string, FsStats>,
): boolean {
  if (!previous) {
    return false;
  }

  const previousStats = previous.stats[path];

  if (!previousStats || previousStats.type !== "dir") {
    return false;
  }

  if (
    previousStats.mtimeMs !== stats.mtimeMs ||
    previousStats.ino !== stats.ino
  ) {
    return false;
  }

  const previousChildNames = collectPreviousChildNames(previous, path);
  const seen = new Set<string>();

  for (const childName of childNames) {
    const childPath = path === "" ? childName : `${path}/${childName}`;
    const prevStats = previous.stats[childPath];
    const currentStats = childStats.get(childName);

    if (!prevStats || !currentStats) {
      return false;
    }

    if (!statsMatch(prevStats, currentStats)) {
      return false;
    }

    seen.add(childName);
  }

  if (seen.size !== previousChildNames.size) {
    return false;
  }

  for (const name of previousChildNames) {
    if (!seen.has(name)) {
      return false;
    }
  }

  return true;
}

async function buildDirectory(
  dir: string,
  relativePath: string,
  entries: FileIndexEntry[],
  merkle: MerkleMap,
  statsMap: StatsMap,
  previous: PreviousIndexData | undefined,
  depth: number,
  context: BuildContext,
): Promise<string> {
  let dirStats: FsStats;

  try {
    dirStats = statSync(dir);
  } catch (err) {
    debugLog("file-index", `Cannot stat directory ${dir}: ${err}`);
    const unreadableHash = hashValue("__unreadable__");
    merkle[relativePath] = unreadableHash;
    return unreadableHash;
  }

  const currentStats: FileStats = {
    type: "dir",
    mtimeMs: dirStats.mtimeMs,
    ino: dirStats.ino ?? 0,
  };

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(dir);
  } catch (err) {
    debugLog("file-index", `Cannot read directory ${dir}: ${err}`);
    const unreadableHash = hashValue("__unreadable__");
    merkle[relativePath] = unreadableHash;
    return unreadableHash;
  }

  const childNames: string[] = [];
  const childStatsMap = new Map<string, FsStats>();

  for (const entry of dirEntries) {
    const entryRelPath =
      relativePath === "" ? entry : `${relativePath}/${entry}`;
    if (shouldExcludeEntry(entry, entryRelPath, indexRoot)) {
      continue;
    }

    try {
      const childStat = statSync(join(dir, entry));
      childNames.push(entry);
      childStatsMap.set(entry, childStat);
    } catch (err) {
      debugLog("file-index", `Cannot stat entry ${join(dir, entry)}: ${err}`);
    }
  }

  if (
    previous !== undefined &&
    shouldReuseDirectory(
      previous,
      relativePath,
      currentStats,
      childNames,
      childStatsMap,
    )
  ) {
    copyStatsSubtree(previous, relativePath, statsMap);
    appendSubtreeEntries(entries, previous, relativePath, context);
    copyMerkleSubtree(previous, relativePath, merkle);
    return previous.merkle[relativePath] ?? hashValue("__reused__");
  }

  statsMap[relativePath] = currentStats;

  if (
    depth >= MAX_INDEX_DEPTH ||
    context.totalEntryCount >= MAX_CACHE_ENTRIES
  ) {
    context.truncated = true;
    const truncatedHash = hashValue("__truncated__");
    merkle[relativePath] = truncatedHash;
    return truncatedHash;
  }

  const childHashes: string[] = [];

  for (const entry of childNames) {
    if (context.totalEntryCount >= MAX_CACHE_ENTRIES) {
      context.truncated = true;
      break;
    }

    // Yield to the event loop every 500 entries to keep the UI responsive
    // during the initial walk of large workspaces.
    if (context.newEntryCount > 0 && context.newEntryCount % 500 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const entryStat = childStatsMap.get(entry);
    if (!entryStat) {
      continue;
    }

    const fullPath = join(dir, entry);
    const entryPath = relative(indexRoot, fullPath);

    if (!entryPath) {
      continue;
    }

    if (entryStat.isDirectory()) {
      entries.push({
        path: entryPath,
        type: "dir",
        lowerPath: entryPath.toLowerCase(),
        parent: normalizeParent(entryPath),
      });
      context.newEntryCount++;
      context.totalEntryCount++;

      // Only recurse if we haven't hit the cap
      if (context.totalEntryCount <= MAX_CACHE_ENTRIES) {
        const childHash = await buildDirectory(
          fullPath,
          entryPath,
          entries,
          merkle,
          statsMap,
          previous,
          depth + 1,
          context,
        );

        childHashes.push(`dir:${entry}:${childHash}`);
      } else {
        // Mark as truncated and use a placeholder hash
        context.truncated = true;
        childHashes.push(`dir:${entry}:${hashValue("__truncated__")}`);
      }
    } else {
      const fileHash = hashFile(fullPath, entryPath, entryStat);

      // Only add to merkle and stats if we haven't hit the cap
      // This prevents unbounded memory growth for large workspaces
      if (context.totalEntryCount <= MAX_CACHE_ENTRIES) {
        statsMap[entryPath] = {
          type: "file",
          mtimeMs: entryStat.mtimeMs,
          ino: entryStat.ino ?? 0,
          size: entryStat.size,
        };

        merkle[entryPath] = fileHash;
      } else {
        context.truncated = true;
      }

      entries.push({
        path: entryPath,
        type: "file",
        lowerPath: entryPath.toLowerCase(),
        parent: normalizeParent(entryPath),
      });
      context.newEntryCount++;
      context.totalEntryCount++;
      childHashes.push(`file:${entry}:${fileHash}`);
    }
  }

  const dirHash = hashValue(childHashes.sort().join("|"));
  merkle[relativePath] = dirHash;
  return dirHash;
}

async function buildIndex(
  previous?: PreviousIndexData,
): Promise<FileIndexBuildResult> {
  const entries: FileIndexEntry[] = [];
  const merkle: MerkleMap = {};
  const statsMap: StatsMap = {};
  const context: BuildContext = {
    newEntryCount: 0,
    totalEntryCount: 0,
    truncated: false,
  };
  const rootHash = await buildDirectory(
    indexRoot,
    "",
    entries,
    merkle,
    statsMap,
    previous,
    0,
    context,
  );

  entries.sort((a, b) => a.path.localeCompare(b.path));

  // Deduplicate by path. Duplicates can occur when a dirty cache is reused
  // via appendSubtreeEntries — the parent pushed the dir entry, and the cache
  // contained it again. This is a one-time cleanup that also writes a clean
  // cache to disk so subsequent sessions start fresh.
  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    if (seen.has(e.path)) return false;
    seen.add(e.path);
    return true;
  });

  return {
    entries: deduped,
    merkle,
    stats: statsMap,
    rootHash,
    truncated: context.truncated,
  };
}

function sanitizeWorkspacePath(workspacePath: string): string {
  const normalizedPath = normalize(workspacePath);
  const strippedPath = normalizedPath.replace(/^[/\\]+/, "");
  const sanitized = strippedPath.replace(/[/\\:]/g, "_").replace(/\s+/g, "_");

  return sanitized.length === 0 ? "workspace" : sanitized;
}

function getProjectStorageDir(): string {
  const homeDir = homedir();
  const sanitizedWorkspace = sanitizeWorkspacePath(indexRoot);
  return join(homeDir, ".letta", "projects", sanitizedWorkspace);
}

function ensureProjectStorageDir(): string {
  const storageDir = getProjectStorageDir();
  if (!existsSync(storageDir)) {
    mkdirSync(storageDir, { recursive: true });
  }
  return storageDir;
}

function getProjectIndexPath(): string {
  return join(getProjectStorageDir(), PROJECT_INDEX_FILENAME);
}

function loadCachedIndex(): FileIndexCache | null {
  const indexPath = getProjectIndexPath();
  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    // Check file size before loading to prevent OOM on massive caches
    // (e.g., 447MB for home directory workspace)
    const stats = statSync(indexPath);
    const fileSizeMB = stats.size / (1024 * 1024);
    if (fileSizeMB > MAX_CACHE_FILE_SIZE_MB) {
      debugLog(
        "file-index",
        `Index cache file too large (${fileSizeMB.toFixed(1)}MB > ${MAX_CACHE_FILE_SIZE_MB}MB), replacing with fresh build`,
      );
      // Delete the bloated cache immediately, then rebuild
      try {
        unlinkSync(indexPath);
      } catch (err) {
        debugLog("file-index", `Failed to delete bloated cache ${indexPath}: ${err}`);
      }
      return null;
    }

    const content = readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(content);

    if (
      parsed?.metadata &&
      typeof parsed.metadata.rootHash === "string" &&
      Array.isArray(parsed.entries) &&
      parsed.merkle &&
      typeof parsed.merkle === "object"
    ) {
      // Version gate: discard caches written by an older (or missing) format
      // so we rebuild with content-based hashes. This is a one-time cost on
      // upgrade — subsequent sessions will load the v2 cache normally.
      if (parsed.metadata.version !== CACHE_VERSION) {
        debugLog(
          "file-index",
          `Cache version mismatch (got ${parsed.metadata.version ?? "none"}, need ${CACHE_VERSION}), rebuilding`,
        );
        try {
          unlinkSync(indexPath);
        } catch (err) {
          debugLog("file-index", `Failed to delete stale cache ${indexPath}: ${err}`);
        }
        return null;
      }

      const merkle: MerkleMap = {};
      for (const [key, value] of Object.entries(parsed.merkle)) {
        if (typeof value === "string") {
          merkle[key] = value;
        }
      }

      const stats: StatsMap = {};
      if (parsed.stats && typeof parsed.stats === "object") {
        for (const [path, rawStats] of Object.entries(parsed.stats)) {
          const sv = rawStats as Record<string, unknown>;
          if (
            sv &&
            typeof sv.mtimeMs === "number" &&
            typeof sv.ino === "number" &&
            (sv.type === "file" || sv.type === "dir")
          ) {
            stats[path] = {
              type: sv.type as "file" | "dir",
              mtimeMs: sv.mtimeMs,
              ino: sv.ino,
              size: typeof sv.size === "number" ? sv.size : undefined,
            };
          }
        }
      }

      return {
        metadata: {
          rootHash: parsed.metadata.rootHash,
          version: CACHE_VERSION,
        },
        entries: parsed.entries,
        merkle,
        stats,
      };
    }
  } catch (err) {
    debugLog("file-index", `Failed to parse index cache ${indexPath}: ${err}`);
  }

  return null;
}

function cacheProjectIndex(result: FileIndexBuildResult): void {
  // Don't cache when running from home directory - it's too large and would
  // cause OOM on next load. The in-memory cache still works for this session.
  if (indexRoot === homedir()) {
    return;
  }

  try {
    const storageDir = ensureProjectStorageDir();
    const indexPath = join(storageDir, PROJECT_INDEX_FILENAME);

    // Cap entries to MAX_CACHE_ENTRIES as a safety net (build should already cap)
    const cappedEntries = result.entries.slice(0, MAX_CACHE_ENTRIES);

    // Only include merkle/stats for entries we're keeping
    const cappedMerkle: MerkleMap = {};
    const cappedStats: StatsMap = {};

    for (const entry of cappedEntries) {
      const merkleValue = result.merkle[entry.path];
      if (merkleValue !== undefined) {
        cappedMerkle[entry.path] = merkleValue;
      }
      const statsValue = result.stats[entry.path];
      if (statsValue !== undefined) {
        cappedStats[entry.path] = statsValue;
      }
    }
    // Include root merkle hash
    const rootMerkle = result.merkle[""];
    if (rootMerkle !== undefined) {
      cappedMerkle[""] = rootMerkle;
    }

    const payload: FileIndexCache = {
      metadata: {
        rootHash: result.rootHash,
        version: CACHE_VERSION,
      },
      entries: cappedEntries,
      merkle: cappedMerkle,
      stats: cappedStats,
    };
    writeFileSync(indexPath, JSON.stringify(payload), "utf-8");
  } catch (err) {
    debugLog("file-index", `Failed to persist index cache: ${err}`);
  }
}

/**
 * Build the in-memory search cache from a full entries list.
 * Sorts dirs first, then by mtime descending (most recently modified files
 * appear first in results), and caps at MAX_CACHE_ENTRIES.
 *
 * NOTE: buildIndex keeps entries sorted by path — that ordering is load-bearing
 * for the binary searches in appendSubtreeEntries/findPrefixRange. This helper
 * produces a separate mtime-sorted copy only for the in-memory search cache.
 */
function buildCachedEntries(
  entries: FileIndexEntry[],
  stats: StatsMap,
): { entries: FileIndexEntry[]; paths: Set<string> } {
  const sorted = [...entries]
    .sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      const aMtime = stats[a.path]?.mtimeMs ?? 0;
      const bMtime = stats[b.path]?.mtimeMs ?? 0;
      return bMtime - aMtime;
    })
    .slice(0, MAX_CACHE_ENTRIES);
  return { entries: sorted, paths: new Set(sorted.map((e) => e.path)) };
}

/**
 * Ensure the file index is built at least once per session.
 */
export function ensureFileIndex(): Promise<void> {
  if (hasCompletedBuild) return Promise.resolve();
  if (!buildPromise) {
    let currentPromise!: Promise<void>;
    currentPromise = (async () => {
      let succeeded = false;
      try {
        const diskIndex = loadCachedIndex();
        const previousData = diskIndex
          ? preparePreviousIndexData(diskIndex)
          : undefined;
        const buildResult = await buildIndex(previousData);

        if (diskIndex && diskIndex.metadata.rootHash === buildResult.rootHash) {
          ({ entries: cachedEntries, paths: cachedEntryPaths } =
            buildCachedEntries(buildResult.entries, buildResult.stats));
          succeeded = true;
          return;
        }

        if (buildResult.truncated) {
          debugLog(
            "file-index",
            `Index truncated: workspace exceeds ${MAX_INDEX_DEPTH} directory levels deep. ` +
              `Files beyond that depth will fall back to disk search.`,
          );
        }

        cacheProjectIndex(buildResult);
        ({ entries: cachedEntries, paths: cachedEntryPaths } =
          buildCachedEntries(buildResult.entries, buildResult.stats));
        succeeded = true;
      } finally {
        // Only clear buildPromise if it's still ours — refreshFileIndex may
        // have already replaced it with a newer promise.
        if (buildPromise === currentPromise) buildPromise = null;
        if (succeeded) hasCompletedBuild = true;
      }
    })();
    buildPromise = currentPromise;
  }

  return buildPromise;
}

export function refreshFileIndex(): Promise<void> {
  hasCompletedBuild = false;
  buildPromise = null;
  return ensureFileIndex();
}

/**
 * Return the current index root directory.
 * All indexed paths are stored relative to this root.
 */
export function getIndexRoot(): string {
  return indexRoot;
}

/**
 * Change the index root directory and trigger a non-blocking rebuild.
 * Unlike `process.chdir()`, this only affects the file index — it does
 * not mutate global process state.
 */
export function setIndexRoot(dir: string): void {
  if (dir === indexRoot) return;
  indexRoot = dir;
  void refreshFileIndex();
}

/**
 * Add newly discovered entries to the in-memory cache without a full rebuild.
 * Called when a disk scan finds files that weren't in the index (e.g. created
 * externally). Skips paths that are already cached.
 *
 * The initial build has priority — it fills the cache up to MAX_CACHE_ENTRIES
 * with the most recently modified files. Disk scan hits fill any remaining
 * space. Once the cap is reached, new entries are not added until the next
 * rebuild; the disk scan will still find them on demand.
 */
export function addEntriesToCache(matches: FileMatch[]): void {
  const available = MAX_CACHE_ENTRIES - cachedEntries.length;
  if (available <= 0) return;

  let added = 0;
  for (const match of matches) {
    if (added >= available) break;
    if (!cachedEntryPaths.has(match.path)) {
      cachedEntries.push({
        path: match.path,
        type: match.type,
        lowerPath: match.path.toLowerCase(),
        parent: normalizeParent(match.path),
      });
      cachedEntryPaths.add(match.path);
      added++;
    }
  }
}

export function searchFileIndex(options: SearchFileIndexOptions): FileMatch[] {
  const { searchDir, pattern, deep, maxResults } = options;
  const normalizedDir = searchDir === "." ? "" : searchDir;
  const dirWithSep = normalizedDir === "" ? "" : `${normalizedDir}${sep}`;
  const lowerPattern = pattern.toLowerCase();
  const results: FileMatch[] = [];

  for (const entry of cachedEntries) {
    if (normalizedDir) {
      if (entry.path !== normalizedDir && !entry.path.startsWith(dirWithSep)) {
        continue;
      }
    }

    if (!deep && entry.parent !== normalizedDir) {
      continue;
    }

    if (lowerPattern && !entry.lowerPath.includes(lowerPattern)) {
      continue;
    }

    results.push({ path: entry.path, type: entry.type });
    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}
