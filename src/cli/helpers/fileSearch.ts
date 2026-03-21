import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getCurrentWorkingDirectory } from "../../runtime-context.js";
import { debugLog } from "../../utils/debug";
import { ensureFileIndex, type FileMatch, searchFileIndex } from "./fileIndex";
import { shouldHardExcludeEntry } from "./fileSearchConfig";

export function debounce<T extends (...args: never[]) => unknown>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;

  return function (this: unknown, ...args: Parameters<T>) {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      func.apply(this, args);
    }, wait);
  };
}

/**
 * Recursively search a directory for files matching a pattern
 */
function searchDirectoryRecursive(
  dir: string,
  pattern: string,
  maxResults: number = 200,
  results: FileMatch[] = [],
  depth: number = 0,
  maxDepth: number = 10,
  lowerPattern: string = pattern.toLowerCase(),
): FileMatch[] {
  if (results.length >= maxResults || depth >= maxDepth) {
    return results;
  }

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      try {
        const fullPath = join(dir, entry);
        const relativePath = relative(getCurrentWorkingDirectory(), fullPath);

        if (shouldHardExcludeEntry(entry)) {
          continue;
        }

        const stats = statSync(fullPath);

        // Check if entry matches the pattern (match against full relative path for partial path support)
        const matches =
          pattern.length === 0 ||
          relativePath.toLowerCase().includes(lowerPattern);

        if (matches) {
          results.push({
            path: relativePath,
            type: stats.isDirectory() ? "dir" : "file",
          });

          if (results.length >= maxResults) {
            return results;
          }
        }

        // Recursively search subdirectories
        if (stats.isDirectory()) {
          searchDirectoryRecursive(
            fullPath,
            pattern,
            maxResults,
            results,
            depth + 1,
            maxDepth,
            lowerPattern,
          );
        }
      } catch {}
    }
  } catch {
    // Can't read directory, skip
  }

  return results;
}

/**
 * Search for files and directories matching the query
 * @param query - The search query (partial file path)
 * @param deep - Whether to search recursively through subdirectories
 * @returns Array of matching files and directories
 */
export async function searchFiles(
  query: string,
  deep: boolean = false,
  cwd?: string,
): Promise<FileMatch[]> {
  const results: FileMatch[] = [];

  try {
    const userCwd = cwd ?? getCurrentWorkingDirectory();

    // Determine the directory to search in
    let searchDir = userCwd;
    let searchPattern = query;

    // Handle explicit relative/absolute paths or directory navigation
    // Treat as directory navigation if:
    // 1. Starts with ./ or ../ or / (explicit relative/absolute path)
    // 2. Contains / and the directory part exists
    if (query.includes("/")) {
      const lastSlashIndex = query.lastIndexOf("/");
      const dirPart = query.slice(0, lastSlashIndex);
      const pattern = query.slice(lastSlashIndex + 1);

      // Try to resolve the directory path
      try {
        const resolvedDir = resolve(userCwd, dirPart);
        // Check if the directory exists by trying to read it
        try {
          statSync(resolvedDir);
          // Directory exists, use it as the search directory
          searchDir = resolvedDir;
          searchPattern = pattern;
        } catch {
          // Directory doesn't exist, treat the whole query as a search pattern
          // This enables partial path matching like "cd/ef" matching "ab/cd/ef"
        }
      } catch {
        // Path resolution failed, treat as pattern
      }
    }

    // If we resolved to a specific directory and the remaining pattern is empty,
    // the user is browsing that directory (e.g., "@../"), not searching within it.
    // Use shallow search to avoid recursively walking the entire subtree.
    const effectiveDeep = deep && searchPattern.length > 0;

    const relativeSearchDir = relative(userCwd, searchDir);
    const normalizedSearchDir =
      relativeSearchDir === "." ? "" : relativeSearchDir;
    const insideWorkspace =
      normalizedSearchDir === "" || !normalizedSearchDir.startsWith("..");

    let indexSearchSucceeded = false;
    if (insideWorkspace) {
      try {
        await ensureFileIndex(userCwd);
        results.push(
          ...searchFileIndex({
            searchDir: normalizedSearchDir,
            pattern: searchPattern,
            deep: effectiveDeep,
            maxResults: effectiveDeep ? 200 : 50,
          }),
        );
        indexSearchSucceeded = true;
      } catch (error) {
        debugLog(
          "file-search",
          "Indexed search failed, falling back to disk scan: %O",
          error,
        );
      }
    }

    if (!indexSearchSucceeded || results.length === 0) {
      if (effectiveDeep) {
        // Deep search: recursively search subdirectories.
        // Use a shallower depth limit when searching outside the project directory
        // to avoid walking massive sibling directory trees.
        const isOutsideCwd = normalizedSearchDir.startsWith("..");
        const maxDepth = isOutsideCwd ? 3 : 10;
        const deepResults = searchDirectoryRecursive(
          searchDir,
          searchPattern,
          200,
          [],
          0,
          maxDepth,
        );
        results.push(...deepResults);
      } else {
        // Shallow search: only one level, regardless of workspace location.
        let entries: string[] = [];
        try {
          entries = readdirSync(searchDir);
        } catch {
          // Directory doesn't exist or can't be read
          return [];
        }

        // Filter entries matching the search pattern.
        // If pattern is empty, show all entries (for when user just types \"@\").
        // Also exclude common dependency/build directories.
        const lowerPattern = searchPattern.toLowerCase();
        const matchingEntries = entries.filter(
          (entry) =>
            !shouldHardExcludeEntry(entry) &&
            (searchPattern.length === 0 ||
              entry.toLowerCase().includes(lowerPattern)),
        );

        // Get stats for each matching entry
        for (const entry of matchingEntries.slice(0, 50)) {
          // Limit to 50 results
          try {
            const fullPath = join(searchDir, entry);
            const stats = statSync(fullPath);

            const relativePath = relative(userCwd, fullPath);

            results.push({
              path: relativePath,
              type: stats.isDirectory() ? "dir" : "file",
            });
          } catch {}
        }
      }
    }

    // Only sort when the disk scan ran — its results come in arbitrary readdir
    // order so we normalise to dirs-first alphabetical. When the index search
    // succeeded the results already come out in mtime order (most recently
    // modified first) from buildCachedEntries, so we leave that order intact.
    if (!indexSearchSucceeded) {
      results.sort((a, b) => {
        if (a.type === "dir" && b.type !== "dir") return -1;
        if (a.type !== "dir" && b.type === "dir") return 1;
        return a.path.localeCompare(b.path);
      });
    }
  } catch (error) {
    // Return empty array on any error
    debugLog("file-search", "File search error: %O", error);
    return [];
  }

  return results;
}
