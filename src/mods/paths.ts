import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

export function resolveDefaultGlobalModsDirectory(
  homeDirectory = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const environmentDirectory =
    env[LETTA_MODS_DIR_ENV]?.trim() ||
    env[LEGACY_LETTA_EXTENSIONS_DIR_ENV]?.trim();
  if (environmentDirectory) return environmentDirectory;

  const modsDirectory = getGlobalModsDirectory(homeDirectory);
  if (existsSync(modsDirectory)) return modsDirectory;

  const legacyDirectory = getLegacyGlobalExtensionsDirectory(homeDirectory);
  if (existsSync(legacyDirectory)) return legacyDirectory;

  return modsDirectory;
}

export function getModCacheDirectory(homeDirectory = homedir()): string {
  return path.join(homeDirectory, ".letta", "mod-cache");
}
