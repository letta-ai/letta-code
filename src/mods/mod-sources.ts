import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { isModFileExtension } from "@/mods/file-extensions";
import {
  type ManagedModPackageDiagnostic,
  resolveManagedModPackages,
} from "@/mods/package-registry";
import {
  getGlobalModsDirectory,
  getLegacyGlobalExtensionsDirectory,
} from "@/mods/paths";
import type { ModSourceScope } from "@/mods/types";

export interface LocalModSource {
  diagnostics?: ManagedModPackageDiagnostic[];
  files: string[];
  legacyMigrationTargetRoot?: string;
  managedPackageRoots?: string[];
  root: string;
  scope: ModSourceScope;
  trusted: boolean;
}

export interface ResolveLocalModSourcesOptions {
  agentModsDirectory?: string;
  cacheDirectory?: string;
  globalModsDirectory?: string;
  includeGlobalMods?: boolean;
  legacyGlobalExtensionsDirectory?: string;
}

function listModFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      if (entry.name.startsWith(".")) return false;
      return isModFileExtension(path.extname(entry.name));
    })
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function resolveLocalModSources(
  options: ResolveLocalModSourcesOptions = {},
): LocalModSource[] {
  const globalModsDirectory =
    options.globalModsDirectory ?? getGlobalModsDirectory();
  const legacyGlobalExtensionsDirectory =
    options.legacyGlobalExtensionsDirectory ??
    (options.globalModsDirectory
      ? undefined
      : getLegacyGlobalExtensionsDirectory());
  const includeGlobalMods = options.includeGlobalMods !== false;
  const managedPackages = includeGlobalMods
    ? resolveManagedModPackages(globalModsDirectory)
    : { diagnostics: [], files: [], packages: [] };
  const sources: LocalModSource[] = [];

  if (
    includeGlobalMods &&
    legacyGlobalExtensionsDirectory &&
    path.resolve(legacyGlobalExtensionsDirectory) !==
      path.resolve(globalModsDirectory) &&
    existsSync(legacyGlobalExtensionsDirectory)
  ) {
    sources.push({
      files: listModFiles(legacyGlobalExtensionsDirectory),
      legacyMigrationTargetRoot: globalModsDirectory,
      root: legacyGlobalExtensionsDirectory,
      scope: "legacy_global",
      trusted: true,
    });
  }

  if (includeGlobalMods) {
    sources.push({
      ...(managedPackages.diagnostics.length > 0
        ? { diagnostics: managedPackages.diagnostics }
        : {}),
      files: [...listModFiles(globalModsDirectory), ...managedPackages.files],
      ...(managedPackages.packages.length > 0
        ? {
            managedPackageRoots: managedPackages.packages.map(
              (pkg) => pkg.root,
            ),
          }
        : {}),
      root: globalModsDirectory,
      scope: "global",
      trusted: true,
    });
  }

  if (options.agentModsDirectory) {
    sources.push({
      files: listModFiles(options.agentModsDirectory),
      root: options.agentModsDirectory,
      scope: "agent",
      trusted: true,
    });
  }

  return sources;
}
