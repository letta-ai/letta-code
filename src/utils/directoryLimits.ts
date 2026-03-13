/**
 * Centralized directory/memfs limits with env overrides for rapid testing.
 */

export const DIRECTORY_LIMIT_ENV = {
  memfsTreeMaxLines: "LETTA_MEMFS_TREE_MAX_LINES",
  memfsTreeMaxChars: "LETTA_MEMFS_TREE_MAX_CHARS",
  listDirMaxLimit: "LETTA_LIST_DIR_MAX_LIMIT",
  listDirMaxDepth: "LETTA_LIST_DIR_MAX_DEPTH",
  listDirMaxOffset: "LETTA_LIST_DIR_MAX_OFFSET",
  listDirMaxCollectedEntries: "LETTA_LIST_DIR_MAX_COLLECTED_ENTRIES",
} as const;

export const DIRECTORY_LIMIT_DEFAULTS = {
  memfsTreeMaxLines: 500,
  memfsTreeMaxChars: 20_000,
  listDirMaxLimit: 200,
  listDirMaxDepth: 5,
  listDirMaxOffset: 10_000,
  listDirMaxCollectedEntries: 12_000,
} as const;

export interface DirectoryLimits {
  memfsTreeMaxLines: number;
  memfsTreeMaxChars: number;
  listDirMaxLimit: number;
  listDirMaxDepth: number;
  listDirMaxOffset: number;
  listDirMaxCollectedEntries: number;
}

function parsePositiveIntEnv(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  if (parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

export function getDirectoryLimits(
  env: NodeJS.ProcessEnv = process.env,
): DirectoryLimits {
  return {
    memfsTreeMaxLines: parsePositiveIntEnv(
      env[DIRECTORY_LIMIT_ENV.memfsTreeMaxLines],
      DIRECTORY_LIMIT_DEFAULTS.memfsTreeMaxLines,
      2,
      50_000,
    ),
    memfsTreeMaxChars: parsePositiveIntEnv(
      env[DIRECTORY_LIMIT_ENV.memfsTreeMaxChars],
      DIRECTORY_LIMIT_DEFAULTS.memfsTreeMaxChars,
      128,
      5_000_000,
    ),
    listDirMaxLimit: parsePositiveIntEnv(
      env[DIRECTORY_LIMIT_ENV.listDirMaxLimit],
      DIRECTORY_LIMIT_DEFAULTS.listDirMaxLimit,
      1,
      10_000,
    ),
    listDirMaxDepth: parsePositiveIntEnv(
      env[DIRECTORY_LIMIT_ENV.listDirMaxDepth],
      DIRECTORY_LIMIT_DEFAULTS.listDirMaxDepth,
      1,
      100,
    ),
    listDirMaxOffset: parsePositiveIntEnv(
      env[DIRECTORY_LIMIT_ENV.listDirMaxOffset],
      DIRECTORY_LIMIT_DEFAULTS.listDirMaxOffset,
      1,
      1_000_000,
    ),
    listDirMaxCollectedEntries: parsePositiveIntEnv(
      env[DIRECTORY_LIMIT_ENV.listDirMaxCollectedEntries],
      DIRECTORY_LIMIT_DEFAULTS.listDirMaxCollectedEntries,
      10,
      2_000_000,
    ),
  };
}
