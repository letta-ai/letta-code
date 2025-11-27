import { promises as fs } from "node:fs";
import * as path from "node:path";
import { validateRequiredParams } from "./validation.js";

const MAX_ENTRY_LENGTH = 500;
const INDENTATION_SPACES = 2;

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
  kind: "directory" | "file" | "symlink" | "other";
}

/**
 * Codex-style list_dir tool.
 * Lists entries with pagination (offset/limit) and depth control.
 */
export async function list_dir(
  args: ListDirCodexArgs,
): Promise<ListDirCodexResult> {
  validateRequiredParams(args, ["dir_path"], "list_dir");

  const { dir_path, offset = 1, limit = 25, depth = 2 } = args;

  if (offset < 1) {
    throw new Error("offset must be a 1-indexed entry number");
  }

  if (limit < 1) {
    throw new Error("limit must be greater than zero");
  }

  if (depth < 1) {
    throw new Error("depth must be greater than zero");
  }

  if (!path.isAbsolute(dir_path)) {
    throw new Error("dir_path must be an absolute path");
  }

  const entries = await listDirSlice(dir_path, offset, limit, depth);
  const output = [`Absolute path: ${dir_path}`, ...entries];

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
): Promise<string[]> {
  const entries: DirEntry[] = [];
  await collectEntries(dirPath, "", maxDepth, entries);

  if (entries.length === 0) {
    return [];
  }

  const startIndex = offset - 1;
  if (startIndex >= entries.length) {
    throw new Error("offset exceeds directory entry count");
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
    formatted.push(`More than ${cappedLimit} entries found`);
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
): Promise<void> {
  const queue: Array<{ absPath: string; prefix: string; depth: number }> = [
    { absPath: dirPath, prefix: relativePrefix, depth: remainingDepth },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
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

    for (const item of dirEntries) {
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
    case "file":
    default:
      break;
  }

  return `${indent}${name}`;
}
