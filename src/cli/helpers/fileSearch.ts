import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

interface FileMatch {
  path: string;
  type: "file" | "dir" | "url";
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;

  return function (this: any, ...args: Parameters<T>) {
    const context = this;

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      func.apply(context, args);
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
): FileMatch[] {
  if (results.length >= maxResults) {
    return results;
  }

  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      // Skip hidden files and common ignore patterns
      if (
        entry.startsWith(".") ||
        entry === "node_modules" ||
        entry === "dist" ||
        entry === "build"
      ) {
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
          searchDirectoryRecursive(fullPath, pattern, maxResults, results);
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

    if (deep) {
      // Deep search: recursively search subdirectories
      const deepResults = searchDirectoryRecursive(
        searchDir,
        searchPattern,
        200, // Max 200 results (no depth limit - will search all nested directories)
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
      const matchingEntries =
        searchPattern.length === 0
          ? entries
          : entries.filter((entry) =>
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
