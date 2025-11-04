import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

interface FileMatch {
  path: string;
  type: "file" | "dir" | "url";
}

/**
 * Recursively search a directory for files matching a pattern
 */
function searchDirectoryRecursive(
  dir: string,
  pattern: string,
  maxDepth: number = 10,
  currentDepth: number = 0,
  maxResults: number = 200,
  results: FileMatch[] = [],
): FileMatch[] {
  if (currentDepth > maxDepth || results.length >= maxResults) {
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

        // Check if entry matches the pattern
        const matches =
          pattern.length === 0 ||
          entry.toLowerCase().includes(pattern.toLowerCase());

        if (matches) {
          const relativePath = fullPath.startsWith(process.cwd())
            ? fullPath.slice(process.cwd().length + 1)
            : fullPath;

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
            maxDepth,
            currentDepth + 1,
            maxResults,
            results,
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

    // Handle relative paths like "./src" or "../test"
    if (query.includes("/")) {
      const lastSlashIndex = query.lastIndexOf("/");
      const dirPart = query.slice(0, lastSlashIndex);
      searchPattern = query.slice(lastSlashIndex + 1);

      // Resolve the directory path
      try {
        searchDir = resolve(process.cwd(), dirPart);
      } catch {
        // If path doesn't exist, return empty results
        return [];
      }
    }

    if (deep) {
      // Deep search: recursively search subdirectories
      const deepResults = searchDirectoryRecursive(
        searchDir,
        searchPattern,
        10, // Max depth of 10 levels (increased to find deeply nested files)
        0,
        200, // Max 200 results (increased to show more matches)
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
