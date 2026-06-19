import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
): string {
  const modsDirectory = getGlobalModsDirectory(homeDirectory);
  if (existsSync(modsDirectory)) return modsDirectory;

  const legacyDirectory = getLegacyGlobalExtensionsDirectory(homeDirectory);
  if (existsSync(legacyDirectory)) return legacyDirectory;

  return modsDirectory;
}

export function getModCacheDirectory(homeDirectory = homedir()): string {
  return path.join(homeDirectory, ".letta", "mod-cache");
}
