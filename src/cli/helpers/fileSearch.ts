import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

interface FileMatch {
  path: string;
  type: "file" | "dir" | "url";
}

/**
 * Directories to exclude from file search autocomplete.
 * These are common dependency/build directories that cause lag when searched.
 * All values are lowercase for case-insensitive matching (Windows compatibility).
 */
const IGNORED_DIRECTORIES = new Set([
  // JavaScript/Node
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "bower_components",

  // Python
  "venv",
  ".venv",
  "__pycache__",
  ".tox",
  "env",

  // Build outputs
  "target", // Rust/Maven/Java
  "out",
  "coverage",
  ".cache",
]);

/**
 * Check if a directory entry should be excluded from search results.
 * Uses case-insensitive matching for Windows compatibility.
 */
function shouldExcludeEntry(entry: string): boolean {
  // Skip hidden files/directories (starts with .)
  if (entry.startsWith(".")) {
    return true;
  }
  // Case-insensitive check for Windows compatibility
  return IGNORED_DIRECTORIES.has(entry.toLowerCase());
}

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
): FileMatch[] {
  if (results.length >= maxResults || depth >= maxDepth) {
    return results;
  }

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      // Skip hidden files and common dependency/build directories
      if (shouldExcludeEntry(entry)) {
        continue;
      }

      try {
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);

        const relativePath = fullPath.startsWith(process.cwd())
          ? fullPath.slice(process.cwd().length + 1)
          : fullPath;

        // Check if entry matches the pattern (match against full relative path for partial path support)
        const matches =
          pattern.length === 0 ||
          relativePath.toLowerCase().includes(pattern.toLowerCase());

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
): Promise<FileMatch[]> {
  const results: FileMatch[] = [];

  try {
    // Determine the directory to search in
    let searchDir = process.cwd();
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
        const resolvedDir = resolve(process.cwd(), dirPart);
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

    if (effectiveDeep) {
      // Deep search: recursively search subdirectories
      // Use a shallower depth limit when searching outside the project directory
      // to avoid walking massive sibling directory trees
      const isOutsideCwd = !searchDir.startsWith(process.cwd());
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
      // Shallow search: only current directory
      let entries: string[] = [];
      try {
        entries = readdirSync(searchDir);
      } catch {
        // Directory doesn't exist or can't be read
        return [];
      }

      // Filter entries matching the search pattern
      // If pattern is empty, show all entries (for when user just types "@")
      // Also exclude common dependency/build directories
      const matchingEntries = entries
        .filter((entry) => !shouldExcludeEntry(entry))
        .filter(
          (entry) =>
            searchPattern.length === 0 ||
            entry.toLowerCase().includes(searchPattern.toLowerCase()),
        );

      // Get stats for each matching entry
      for (const entry of matchingEntries.slice(0, 50)) {
        // Limit to 50 results
        try {
          const fullPath = join(searchDir, entry);
          const stats = statSync(fullPath);

          // Make path relative to cwd if possible
          const relativePath = fullPath.startsWith(process.cwd())
            ? fullPath.slice(process.cwd().length + 1)
            : fullPath;

          results.push({
            path: relativePath,
            type: stats.isDirectory() ? "dir" : "file",
          });
        } catch {}
      }
    }

    // Sort: directories first, then files, alphabetically within each group
    results.sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      return a.path.localeCompare(b.path);
    });
  } catch (error) {
    // Return empty array on any error
    console.error("File search error:", error);
    return [];
  }

  return results;
}
