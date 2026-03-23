import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getDirectoryLimits } from "../../utils/directoryLimits.js";
import { validateRequiredParams } from "./validation.js";

const MAX_ENTRY_LENGTH = 500;
const INDENTATION_SPACES = 2;
const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 25;
const DEFAULT_DEPTH = 2;

interface ListDirCodexArgs {
  dir_path: string;
  offset?: number;
  limit?: number;
  depth?: number;
}

interface ListDirCodexResult {
  content: string;
}

interface DirEntry {
  name: string; // Full relative path for sorting
  displayName: string; // Just the filename for display
  depth: number; // Indentation depth
  kind: "directory" | "file" | "symlink" | "other" | "omitted";
}

interface CollectEntriesResult {
  hitCollectionCap: boolean;
  hitFolderTruncation: boolean;
}

/**
 * Codex-style list_dir tool.
 * Lists entries with pagination and depth control.
 *
 * Defaults:
 * - offset: 1 (1-indexed)
 * - limit: 25
 * - depth: 2 (immediate children + one nested level)
 */
export async function list_dir(
  args: ListDirCodexArgs,
): Promise<ListDirCodexResult> {
  validateRequiredParams(args, ["dir_path"], "list_dir");
  const limits = getDirectoryLimits();

  const {
    dir_path,
    offset = DEFAULT_OFFSET,
    limit = DEFAULT_LIMIT,
    depth = DEFAULT_DEPTH,
  } = args;
  const userCwd = process.env.USER_CWD || process.cwd();
  const resolvedPath = path.isAbsolute(dir_path)
    ? dir_path
    : path.resolve(userCwd, dir_path);

  if (!Number.isInteger(offset) || offset < 1) {
    throw new Error("offset must be a positive integer (1-indexed)");
  }

  if (offset > limits.listDirMaxOffset) {
    throw new Error(
      `offset must be less than or equal to ${limits.listDirMaxOffset.toLocaleString()}`,
    );
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }

  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error("depth must be a positive integer");
  }

  const effectiveLimit = Math.min(limit, limits.listDirMaxLimit);
  const effectiveDepth = Math.min(depth, limits.listDirMaxDepth);

  const entries = await listDirSlice(
    resolvedPath,
    offset,
    effectiveLimit,
    effectiveDepth,
    limits.listDirMaxCollectedEntries,
    limits.listDirMaxChildrenPerDir,
  );
  const output = [`Absolute path: ${resolvedPath}`, ...entries];

  if (effectiveLimit !== limit || effectiveDepth !== depth) {
    output.push(
      `[Request capped: limit=${limit}->${effectiveLimit}, depth=${depth}->${effectiveDepth}]`,
    );
  }

  return { content: output.join("\n") };
}

/**
 * List directory entries with pagination.
 */
async function listDirSlice(
  dirPath: string,
  offset: number,
  limit: number,
  maxDepth: number,
  maxCollectedEntries: number,
  maxChildrenPerDir: number,
): Promise<string[]> {
  const entries: DirEntry[] = [];
  // Collect one extra entry when possible so callers can tell if more data exists.
  const maxEntriesToCollect = Math.min(offset + limit, maxCollectedEntries);

  const { hitCollectionCap, hitFolderTruncation } = await collectEntries(
    dirPath,
    "",
    maxDepth,
    entries,
    maxEntriesToCollect,
    maxChildrenPerDir,
  );

  if (entries.length === 0) {
    return [];
  }

  const startIndex = offset - 1;
  if (startIndex >= entries.length) {
    throw new Error(
      `offset exceeds available entries in current view (max offset: ${entries.length.toLocaleString()})`,
    );
  }

  const remainingEntries = entries.length - startIndex;
  const cappedLimit = Math.min(limit, remainingEntries);
  const endIndex = startIndex + cappedLimit;

  // Get the selected entries and sort by name
  const selectedEntries = entries.slice(startIndex, endIndex);
  selectedEntries.sort((a, b) => a.name.localeCompare(b.name));

  const formatted: string[] = [];
  for (const entry of selectedEntries) {
    formatted.push(formatEntryLine(entry));
  }

  if (endIndex < entries.length) {
    formatted.push(
      `More entries available. Use offset=${endIndex + 1} to continue.`,
    );
  } else if (hitCollectionCap || hitFolderTruncation) {
    formatted.push("More entries may exist beyond the current truncated view.");
  }

  return formatted;
}

/**
 * Recursively collect directory entries using BFS.
 */
async function collectEntries(
  dirPath: string,
  relativePrefix: string,
  remainingDepth: number,
  entries: DirEntry[],
  maxEntriesToCollect: number,
  maxChildrenPerDir: number,
): Promise<CollectEntriesResult> {
  const queue: Array<{ absPath: string; prefix: string; depth: number }> = [
    { absPath: dirPath, prefix: relativePrefix, depth: remainingDepth },
  ];
  let hitFolderTruncation = false;

  while (queue.length > 0) {
    if (entries.length >= maxEntriesToCollect) {
      return { hitCollectionCap: true, hitFolderTruncation };
    }

    const current = queue.shift();
    if (!current) break;
    const { absPath, prefix, depth } = current;

    const dirEntries: Array<{
      absPath: string;
      relativePath: string;
      kind: DirEntry["kind"];
      entry: DirEntry;
    }> = [];

    try {
      const items = await fs.readdir(absPath, { withFileTypes: true });

      for (const item of items) {
        const itemAbsPath = path.join(absPath, item.name);
        const relativePath = prefix ? path.join(prefix, item.name) : item.name;
        const displayName = formatEntryComponent(item.name);
        const displayDepth = prefix ? prefix.split(path.sep).length : 0;
        const sortKey = formatEntryName(relativePath);

        let kind: DirEntry["kind"];
        if (item.isSymbolicLink()) {
          kind = "symlink";
        } else if (item.isDirectory()) {
          kind = "directory";
        } else if (item.isFile()) {
          kind = "file";
        } else {
          kind = "other";
        }

        dirEntries.push({
          absPath: itemAbsPath,
          relativePath,
          kind,
          entry: {
            name: sortKey,
            displayName,
            depth: displayDepth,
            kind,
          },
        });
      }
    } catch (err) {
      throw new Error(`failed to read directory: ${err}`);
    }

    // Sort entries alphabetically
    dirEntries.sort((a, b) => a.entry.name.localeCompare(b.entry.name));

    const visibleEntries = dirEntries.slice(0, maxChildrenPerDir);
    const omittedEntries = Math.max(
      0,
      dirEntries.length - visibleEntries.length,
    );

    if (omittedEntries > 0) {
      hitFolderTruncation = true;

      const omittedSortKey = formatEntryName(
        `${prefix ? `${prefix}/` : ""}\uffff-omitted`,
      );
      const omittedDepth = prefix ? prefix.split(path.sep).length : 0;

      visibleEntries.push({
        absPath,
        relativePath: prefix,
        kind: "omitted",
        entry: {
          name: omittedSortKey,
          displayName: `… (${omittedEntries.toLocaleString()} more entries)`,
          depth: omittedDepth,
          kind: "omitted",
        },
      });
    }

    for (const item of visibleEntries) {
      if (entries.length >= maxEntriesToCollect) {
        return { hitCollectionCap: true, hitFolderTruncation };
      }

      // Queue subdirectories for traversal if depth allows
      if (item.kind === "directory" && depth > 1) {
        queue.push({
          absPath: item.absPath,
          prefix: item.relativePath,
          depth: depth - 1,
        });
      }
      entries.push(item.entry);
    }
  }

  return { hitCollectionCap: false, hitFolderTruncation };
}

/**
 * Format entry name for sorting (normalize path separators).
 */
function formatEntryName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.length > MAX_ENTRY_LENGTH) {
    return normalized.substring(0, MAX_ENTRY_LENGTH);
  }
  return normalized;
}

/**
 * Format a single path component.
 */
function formatEntryComponent(name: string): string {
  if (name.length > MAX_ENTRY_LENGTH) {
    return name.substring(0, MAX_ENTRY_LENGTH);
  }
  return name;
}

/**
 * Format a directory entry for display.
 */
function formatEntryLine(entry: DirEntry): string {
  const indent = " ".repeat(entry.depth * INDENTATION_SPACES);
  let name = entry.displayName;

  switch (entry.kind) {
    case "directory":
      name += "/";
      break;
    case "symlink":
      name += "@";
      break;
    case "other":
      name += "?";
      break;
    case "omitted":
      break;
    default:
      // "file" type has no suffix
      break;
  }

  return `${indent}${name}`;
}
