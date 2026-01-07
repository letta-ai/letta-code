/**
 * Utilities for writing tool output overflow to files.
 * When tool outputs exceed truncation limits, the full output is written to disk
 * and a pointer is provided in the truncated output.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Configuration options for tool output overflow behavior.
 * Can be controlled via environment variables.
 */
export const OVERFLOW_CONFIG = {
  /** Whether to write overflow to files (default: true) */
  ENABLED: process.env.LETTA_TOOL_OVERFLOW_TO_FILE?.toLowerCase() !== "false",
  /** Whether to use middle-truncation instead of post-truncation (default: true) */
  MIDDLE_TRUNCATE:
    process.env.LETTA_TOOL_MIDDLE_TRUNCATE?.toLowerCase() !== "false",
} as const;

/**
 * Get the overflow directory for the current project.
 * Pattern: ~/.letta/projects/<project-path>/agent-tools/
 *
 * @param workingDirectory - Current working directory (project root)
 * @returns Absolute path to the overflow directory
 */
export function getOverflowDirectory(workingDirectory: string): string {
  const homeDir = os.homedir();
  const lettaDir = path.join(homeDir, ".letta");

  // Normalize and sanitize the working directory path for use in the file system
  const normalizedPath = path.normalize(workingDirectory);
  // Remove leading slash and replace path separators with underscores
  const sanitizedPath = normalizedPath
    .replace(/^[/\\]/, "") // Remove leading slash
    .replace(/[/\\:]/g, "_") // Replace slashes and colons
    .replace(/\s+/g, "_"); // Replace spaces with underscores

  const overflowDir = path.join(
    lettaDir,
    "projects",
    sanitizedPath,
    "agent-tools",
  );

  return overflowDir;
}

/**
 * Ensure the overflow directory exists, creating it if necessary.
 *
 * @param workingDirectory - Current working directory (project root)
 * @returns Absolute path to the overflow directory
 */
export function ensureOverflowDirectory(workingDirectory: string): string {
  const overflowDir = getOverflowDirectory(workingDirectory);

  if (!fs.existsSync(overflowDir)) {
    fs.mkdirSync(overflowDir, { recursive: true });
  }

  return overflowDir;
}

/**
 * Write tool output to an overflow file.
 *
 * @param content - Full content to write
 * @param workingDirectory - Current working directory (project root)
 * @param toolName - Name of the tool (optional, for filename)
 * @returns Absolute path to the written file
 */
export function writeOverflowFile(
  content: string,
  workingDirectory: string,
  toolName?: string,
): string {
  const overflowDir = ensureOverflowDirectory(workingDirectory);

  // Generate a unique filename
  const uuid = randomUUID();
  const filename = toolName
    ? `${toolName.toLowerCase()}-${uuid}.txt`
    : `${uuid}.txt`;

  const filePath = path.join(overflowDir, filename);

  // Write the content to the file
  fs.writeFileSync(filePath, content, "utf-8");

  return filePath;
}

/**
 * Clean up old overflow files to prevent directory bloat.
 * Removes files older than the specified age.
 *
 * @param workingDirectory - Current working directory (project root)
 * @param maxAgeMs - Maximum age in milliseconds (default: 24 hours)
 * @returns Number of files deleted
 */
export function cleanupOldOverflowFiles(
  workingDirectory: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): number {
  const overflowDir = getOverflowDirectory(workingDirectory);

  if (!fs.existsSync(overflowDir)) {
    return 0;
  }

  const files = fs.readdirSync(overflowDir);
  const now = Date.now();
  let deletedCount = 0;

  for (const file of files) {
    const filePath = path.join(overflowDir, file);
    const stats = fs.statSync(filePath);

    if (now - stats.mtimeMs > maxAgeMs) {
      fs.unlinkSync(filePath);
      deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * Get overflow file statistics for debugging/monitoring.
 *
 * @param workingDirectory - Current working directory (project root)
 * @returns Statistics object
 */
export function getOverflowStats(workingDirectory: string): {
  directory: string;
  exists: boolean;
  fileCount: number;
  totalSize: number;
} {
  const overflowDir = getOverflowDirectory(workingDirectory);

  if (!fs.existsSync(overflowDir)) {
    return {
      directory: overflowDir,
      exists: false,
      fileCount: 0,
      totalSize: 0,
    };
  }

  const files = fs.readdirSync(overflowDir);
  let totalSize = 0;

  for (const file of files) {
    const filePath = path.join(overflowDir, file);
    const stats = fs.statSync(filePath);
    totalSize += stats.size;
  }

  return {
    directory: overflowDir,
    exists: true,
    fileCount: files.length,
    totalSize,
  };
}
