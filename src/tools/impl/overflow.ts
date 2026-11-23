import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { scrubSecretsFromString } from "@/tools/secret-substitution";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

export const OVERFLOW_CONFIG = {
  ENABLED: process.env.LETTA_TOOL_OVERFLOW_TO_FILE?.toLowerCase() !== "false",
  MIDDLE_TRUNCATE:
    process.env.LETTA_TOOL_MIDDLE_TRUNCATE?.toLowerCase() !== "false",
} as const;

export function getOverflowDirectory(workingDirectory: string): string {
  const configDir = resolveGlobalConfigDir();

  const normalizedPath = path.normalize(workingDirectory);
  const sanitizedPath = normalizedPath
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "_")
    .replace(/\s+/g, "_");

  const overflowDir = path.join(
    configDir,
    "projects",
    sanitizedPath,
    "agent-tools",
  );

  return overflowDir;
}

export function ensureOverflowDirectory(workingDirectory: string): string {
  const overflowDir = getOverflowDirectory(workingDirectory);

  if (!fs.existsSync(overflowDir)) {
    fs.mkdirSync(overflowDir, { recursive: true });
  }

  return overflowDir;
}

export function writeOverflowFile(
  content: string,
  workingDirectory: string,
  toolName?: string,
  secrets: Readonly<Record<string, string>> = {},
): string {
  const overflowDir = ensureOverflowDirectory(workingDirectory);

  const uuid = randomUUID();
  const filename = toolName
    ? `${toolName.toLowerCase()}-${uuid}.txt`
    : `${uuid}.txt`;

  const filePath = path.join(overflowDir, filename);

  fs.writeFileSync(filePath, scrubSecretsFromString(content, secrets), "utf-8");

  return filePath;
}

export function cleanupOldOverflowFiles(
  workingDirectory: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): number {
  const overflowDir = getOverflowDirectory(workingDirectory);

  if (!fs.existsSync(overflowDir)) {
    return 0;
  }

  let files: string[];
  try {
    files = fs.readdirSync(overflowDir);
  } catch {
    return 0;
  }

  const now = Date.now();
  let deletedCount = 0;

  for (const file of files) {
    const filePath = path.join(overflowDir, file);
    try {
      const stats = fs.statSync(filePath);

      if (stats.isDirectory()) {
        continue;
      }

      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    } catch {}
  }

  return deletedCount;
}

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
