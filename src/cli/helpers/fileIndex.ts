import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Stats as FsStats } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, normalize, relative, sep } from "node:path";
import { shouldExcludeEntry } from "./fileSearchConfig";
import { debugLog } from "../../utils/debug";

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

let cachedEntries: FileIndexEntry[] = [];
let buildPromise: Promise<void> | null = null;
let hasCompletedBuild = false;

interface FileIndexCache {
  metadata: {
    rootHash: string;
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

function findExactEntryIndex(entryPaths: string[], target: string): number {
  let low = 0;
  let high = entryPaths.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const midPath = entryPaths[mid];

    if (midPath === undefined) break;

    if (midPath === target) {
      return mid;
    }

    if (midPath < target) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return -1;
}

function findPrefixRange(sorted: string[], prefix: string): [number, number] {
  const start = lowerBound(sorted, prefix);
  let end = start;

  while (end < sorted.length && sorted[end]!.startsWith(prefix)) {
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
): void {
  if (path === "") {
    targetEntries.push(...previous.entries);
    return;
  }

  const { entryPaths, entries: previousEntries } = previous;
  const exactIndex = findExactEntryIndex(entryPaths, path);

  if (exactIndex !== -1) {
    const entry = previousEntries[exactIndex];
    if (entry !== undefined) targetEntries.push(entry);
  }

  const prefix = `${path}/`;
  const [start, end] = findPrefixRange(entryPaths, prefix);

  for (let i = start; i < end; i++) {
    const entry = previousEntries[i];
    if (entry !== undefined) targetEntries.push(entry);
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
  const start = prefix === "" ? 0 : lowerBound(previous.merkleKeys, prefix);
  let idx = start;

  while (idx < previous.merkleKeys.length) {
    const key = previous.merkleKeys[idx];

    if (key === undefined) break;

    if (prefix === "" || key === path || key.startsWith(prefix)) {
      target[key] = previous.merkle[key] ?? "";
      idx++;
      continue;
    }

    break;
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
  const [start, end] = prefix === "" ? [0, previous.statsKeys.length] : findPrefixRange(previous.statsKeys, prefix);

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

  for (const key of previous.statsKeys) {
    if (!key.startsWith(prefix) || key === path) {
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

  if (
    prev.mtimeMs !== current.mtimeMs ||
    prev.ino !== (current.ino ?? 0)
  ) {
    return false;
  }

  if (prev.type === "file") {
    return typeof prev.size === "number"
      ? prev.size === current.size
      : true;
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
  let dirStats;

  try {
    dirStats = statSync(dir);
  } catch {
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
  } catch {
    const unreadableHash = hashValue("__unreadable__");
    merkle[relativePath] = unreadableHash;
    return unreadableHash;
  }

  const childNames: string[] = [];
  const childStatsMap = new Map<string, FsStats>();

  for (const entry of dirEntries) {
    const entryRelPath = relativePath === "" ? entry : `${relativePath}/${entry}`;
    if (shouldExcludeEntry(entry, entryRelPath)) {
      continue;
    }

    try {
      const childStat = statSync(join(dir, entry));
      childNames.push(entry);
      childStatsMap.set(entry, childStat);
    } catch {
      continue;
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
    appendSubtreeEntries(entries, previous, relativePath);
    copyMerkleSubtree(previous, relativePath, merkle);
    return previous.merkle[relativePath] ?? hashValue("__reused__");
  }

  statsMap[relativePath] = currentStats;

  if (depth >= MAX_INDEX_DEPTH) {
    context.truncated = true;
    const truncatedHash = hashValue("__truncated__");
    merkle[relativePath] = truncatedHash;
    return truncatedHash;
  }

  const childHashes: string[] = [];

  for (const entry of childNames) {
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
    const entryPath = relative(process.cwd(), fullPath);

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
      const fileHash = hashValue(
        `${entryPath}:${entryStat.size}:${entryStat.mtimeMs}:${entryStat.ino ?? 0}`,
      );

      statsMap[entryPath] = {
        type: "file",
        mtimeMs: entryStat.mtimeMs,
        ino: entryStat.ino ?? 0,
        size: entryStat.size,
      };

      merkle[entryPath] = fileHash;
      entries.push({
        path: entryPath,
        type: "file",
        lowerPath: entryPath.toLowerCase(),
        parent: normalizeParent(entryPath),
      });
      context.newEntryCount++;
      childHashes.push(`file:${entry}:${fileHash}`);
    }
  }

  const dirHash = hashValue(childHashes.sort().join("|"));
  merkle[relativePath] = dirHash;
  return dirHash;
}

async function buildIndex(previous?: PreviousIndexData): Promise<FileIndexBuildResult> {
  const entries: FileIndexEntry[] = [];
  const merkle: MerkleMap = {};
  const statsMap: StatsMap = {};
  const context: BuildContext = { newEntryCount: 0, truncated: false };
  const rootHash = await buildDirectory(
    process.cwd(),
    "",
    entries,
    merkle,
    statsMap,
    previous,
    0,
    context,
  );

  entries.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.path.localeCompare(b.path);
  });

  return { entries, merkle, stats: statsMap, rootHash, truncated: context.truncated };
}

function sanitizeWorkspacePath(workspacePath: string): string {
  const normalizedPath = normalize(workspacePath);
  const strippedPath = normalizedPath.replace(/^[/\\]+/, "");
  const sanitized = strippedPath
    .replace(/[/\\:]/g, "_")
    .replace(/\s+/g, "_");

  return sanitized.length === 0 ? "workspace" : sanitized;
}

function getProjectStorageDir(): string {
  const homeDir = homedir();
  const sanitizedWorkspace = sanitizeWorkspacePath(process.cwd());
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
    const content = readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(content);

    if (
      parsed &&
      parsed.metadata &&
      typeof parsed.metadata.rootHash === "string" &&
      Array.isArray(parsed.entries) &&
      parsed.merkle &&
      typeof parsed.merkle === "object"
    ) {
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
            typeof sv["mtimeMs"] === "number" &&
            typeof sv["ino"] === "number" &&
            (sv["type"] === "file" || sv["type"] === "dir")
          ) {
            stats[path] = {
              type: sv["type"] as "file" | "dir",
              mtimeMs: sv["mtimeMs"],
              ino: sv["ino"],
            };
          }
        }
      }

      return {
        metadata: {
          rootHash: parsed.metadata.rootHash,
        },
        entries: parsed.entries,
        merkle,
        stats,
      };
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}


function cacheProjectIndex(result: FileIndexBuildResult): void {
  try {
    const storageDir = ensureProjectStorageDir();
    const indexPath = join(storageDir, PROJECT_INDEX_FILENAME);
    const payload: FileIndexCache = {
      metadata: {
        rootHash: result.rootHash,
      },
      entries: result.entries,
      merkle: result.merkle,
      stats: result.stats,
    };
    writeFileSync(indexPath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // Silently ignore persistence errors to avoid breaking search.
  }
}

/**
 * Ensure the file index is built at least once per session.
 */
export function ensureFileIndex(): Promise<void> {
  if (hasCompletedBuild) return Promise.resolve();
  if (!buildPromise) {
    buildPromise = (async () => {
      let succeeded = false;
      try {
        const diskIndex = loadCachedIndex();
        const previousData = diskIndex ? preparePreviousIndexData(diskIndex) : undefined;
        const buildResult = await buildIndex(previousData);

        if (diskIndex && diskIndex.metadata.rootHash === buildResult.rootHash) {
          cachedEntries = diskIndex.entries;
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
        cachedEntries = buildResult.entries;
        succeeded = true;
      } finally {
        buildPromise = null;
        if (succeeded) hasCompletedBuild = true;
      }
    })();
  }

  return buildPromise;
}

export function refreshFileIndex(): Promise<void> {
  hasCompletedBuild = false;
  buildPromise = null;
  return ensureFileIndex();
}

/**
 * Add newly discovered entries to the in-memory cache without a full rebuild.
 * Called when a disk scan finds files that weren't in the index (e.g. created
 * externally). Skips paths that are already cached.
 */
export function addEntriesToCache(matches: FileMatch[]): void {
  const existingPaths = new Set(cachedEntries.map((e) => e.path));
  for (const match of matches) {
    if (!existingPaths.has(match.path)) {
      cachedEntries.push({
        path: match.path,
        type: match.type,
        lowerPath: match.path.toLowerCase(),
        parent: normalizeParent(match.path),
      });
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


