import { existsSync } from "node:fs";
import path from "node:path";
import {
  hasGlobalConfigDirOverride,
  resolveGlobalConfigDir,
} from "@/utils/settings-path";

export const LETTA_MODS_DIR_ENV = "LETTA_MODS_DIR";
export const LEGACY_LETTA_EXTENSIONS_DIR_ENV = "LETTA_EXTENSIONS_DIR";

function getModsStateRoot(
  homeDirectory: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  return homeDirectory === undefined || hasGlobalConfigDirOverride(env)
    ? resolveGlobalConfigDir(env, homeDirectory)
    : path.join(homeDirectory, ".letta");
}

export function getGlobalModsDirectory(
  homeDirectory?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getModsStateRoot(homeDirectory, env), "mods");
}

export function getLegacyGlobalExtensionsDirectory(
  homeDirectory?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getModsStateRoot(homeDirectory, env), "extensions");
}

export function resolveDefaultGlobalModsDirectory(
  homeDirectory?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const environmentDirectory =
    env[LETTA_MODS_DIR_ENV]?.trim() ||
    env[LEGACY_LETTA_EXTENSIONS_DIR_ENV]?.trim();
  if (environmentDirectory) return environmentDirectory;

  const modsDirectory = getGlobalModsDirectory(homeDirectory, env);
  if (existsSync(modsDirectory)) return modsDirectory;

  const legacyDirectory = getLegacyGlobalExtensionsDirectory(
    homeDirectory,
    env,
  );
  if (existsSync(legacyDirectory)) return legacyDirectory;

  return modsDirectory;
}

export function getModCacheDirectory(
  homeDirectory?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(getModsStateRoot(homeDirectory, env), "mod-cache");
}
