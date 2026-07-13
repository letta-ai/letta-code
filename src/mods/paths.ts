import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ResolvedGlobalModDirectories {
  globalModsDirectory: string;
  legacyGlobalExtensionsDirectory: string;
}

export const LETTA_MODS_DIR_ENV = "LETTA_MODS_DIR";
export const LEGACY_LETTA_EXTENSIONS_DIR_ENV = "LETTA_EXTENSIONS_DIR";

export function getGlobalModsDirectory(homeDirectory = homedir()): string {
  return path.join(homeDirectory, ".letta", "mods");
}

export function getLegacyGlobalExtensionsDirectory(
  homeDirectory = homedir(),
): string {
  return path.join(homeDirectory, ".letta", "extensions");
}

function getModsDirectoryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<ResolvedGlobalModDirectories> {
  return {
    globalModsDirectory: env[LETTA_MODS_DIR_ENV]?.trim(),
    legacyGlobalExtensionsDirectory:
      env[LEGACY_LETTA_EXTENSIONS_DIR_ENV]?.trim(),
  };
}

/**
 * Resolves the single best directory to use as the global mods root — for
 * install, update, and remove commands that need to pick ONE target directory.
 * Unlike {@link resolveGlobalModDirectories}, this falls back from
 * ~/.letta/mods/ to ~/.letta/extensions/ when the former does not exist,
 * matching the intent that the user's existing directory (whichever it is)
 * should be the install target.
 *
 * Resolution order:
 *   LETTA_MODS_DIR env → LETTA_EXTENSIONS_DIR env →
 *   ~/.letta/mods/ (if it exists) → ~/.letta/extensions/ (if it exists) →
 *   ~/.letta/mods/ (default).
 */
export function resolveDefaultGlobalModsDirectory(
  homeDirectory = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envDirs = getModsDirectoryFromEnv(env);
  const environmentDirectory =
    envDirs.globalModsDirectory || envDirs.legacyGlobalExtensionsDirectory;
  if (environmentDirectory) return environmentDirectory;

  const modsDirectory = getGlobalModsDirectory(homeDirectory);
  if (existsSync(modsDirectory)) return modsDirectory;

  const legacyDirectory = getLegacyGlobalExtensionsDirectory(homeDirectory);
  if (existsSync(legacyDirectory)) return legacyDirectory;

  return modsDirectory;
}

/**
 * Resolves the default global mods directory and legacy extensions directory
 * for the runtime mod loader. Unlike {@link resolveDefaultGlobalModsDirectory},
 * this does NOT fall back from ~/.letta/mods/ to ~/.letta/extensions/ — the
 * runtime always checks both directories separately so that legacy extensions
 * keep their migration diagnostic regardless of which directory exists.
 *
 * Resolution for the global directory:
 *   LETTA_MODS_DIR env → ~/.letta/mods/ default.
 *
 * Resolution for the legacy directory:
 *   LETTA_EXTENSIONS_DIR env → ~/.letta/extensions/ default.
 */
export function resolveGlobalModDirectories(
  homeDirectory = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGlobalModDirectories {
  const envDirs = getModsDirectoryFromEnv(env);
  return {
    globalModsDirectory:
      envDirs.globalModsDirectory ?? getGlobalModsDirectory(homeDirectory),
    legacyGlobalExtensionsDirectory:
      envDirs.legacyGlobalExtensionsDirectory ??
      getLegacyGlobalExtensionsDirectory(homeDirectory),
  };
}

export function getModCacheDirectory(homeDirectory = homedir()): string {
  return path.join(homeDirectory, ".letta", "mod-cache");
}
