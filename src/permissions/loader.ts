// src/permissions/loader.ts
// Load and merge permission settings from hierarchical sources

import { createHash } from "node:crypto";
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { exists, readFile, writeFile } from "../utils/fs.js";
import {
  normalizePermissionRule,
  permissionRulesEquivalent,
} from "./rule-normalization";
import type { PermissionRules } from "./types";

type SettingsFile = {
  permissions?: Record<string, string[]>;
  [key: string]: unknown;
};

type UserSettingsPathsOptions = {
  homeDir?: string;
  xdgConfigHome?: string;
};

type FileSignature =
  | {
      exists: true;
      mtimeMs: number;
      size: number;
      hash: string;
    }
  | { exists: false };

type PermissionCacheEntry = {
  permissions: PermissionRules;
  sources: string[];
  signatures: Map<string, FileSignature>;
};

const permissionCache = new Map<string, PermissionCacheEntry>();
const watchers = new Map<string, FSWatcher>();

export function getUserSettingsPaths(options: UserSettingsPathsOptions = {}): {
  canonical: string;
  legacy: string;
} {
  const homeDir = options.homeDir || homedir();
  const xdgConfigHome =
    options.xdgConfigHome ||
    process.env.XDG_CONFIG_HOME ||
    join(homeDir, ".config");

  return {
    canonical: join(homeDir, ".letta", "settings.json"),
    legacy: join(xdgConfigHome, "letta", "settings.json"),
  };
}

function getPermissionSourcePaths(workingDirectory: string): string[] {
  const { canonical: userSettingsPath, legacy: legacyUserSettingsPath } =
    getUserSettingsPaths();
  return [
    legacyUserSettingsPath, // User legacy
    userSettingsPath, // User (canonical)
    join(workingDirectory, ".letta", "settings.json"), // Project
    join(workingDirectory, ".letta", "settings.local.json"), // Local
  ];
}

function getFileSignature(path: string): FileSignature {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return { exists: false };
    }
    return {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  } catch {
    return { exists: false };
  }
}

function getFileSignatures(paths: string[]): Map<string, FileSignature> {
  const signatures = new Map<string, FileSignature>();
  for (const path of paths) {
    signatures.set(path, getFileSignature(path));
  }
  return signatures;
}

function signaturesEqual(
  a: FileSignature | undefined,
  b: FileSignature | undefined,
): boolean {
  if (!a || !b) return false;
  if (!a.exists || !b.exists) return a.exists === b.exists;
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.hash === b.hash;
}

function cachedEntryMatchesSources(
  entry: PermissionCacheEntry,
  sources: string[],
  signatures: Map<string, FileSignature>,
): boolean {
  if (entry.sources.length !== sources.length) {
    return false;
  }
  for (let i = 0; i < sources.length; i += 1) {
    if (entry.sources[i] !== sources[i]) {
      return false;
    }
  }
  for (const source of sources) {
    if (
      !signaturesEqual(entry.signatures.get(source), signatures.get(source))
    ) {
      return false;
    }
  }
  return true;
}

function clonePermissions(permissions: PermissionRules): PermissionRules {
  return {
    allow: [...(permissions.allow || [])],
    deny: [...(permissions.deny || [])],
    ask: [...(permissions.ask || [])],
    additionalDirectories: [...(permissions.additionalDirectories || [])],
  };
}

function invalidatePermissionSource(sourcePath: string): void {
  for (const [cacheKey, entry] of permissionCache) {
    if (entry.sources.includes(sourcePath)) {
      permissionCache.delete(cacheKey);
    }
  }
}

function invalidatePermissionSourcesInDirectory(directoryPath: string): void {
  for (const [cacheKey, entry] of permissionCache) {
    if (entry.sources.some((source) => dirname(source) === directoryPath)) {
      permissionCache.delete(cacheKey);
    }
  }
}

function watchPath(path: string, onChange: () => void): void {
  if (watchers.has(path) || !exists(path)) {
    return;
  }

  try {
    const watcher = watch(path, { persistent: false }, onChange);
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(path);
      onChange();
    });
    watchers.set(path, watcher);
  } catch {
    // fs.watch can fail on some filesystems; loadPermissions still validates
    // file signatures on every call, so missed watchers only cost one stat.
  }
}

function ensurePermissionWatchers(sources: string[]): void {
  for (const source of sources) {
    watchPath(source, () => invalidatePermissionSource(source));

    const directoryPath = dirname(source);
    watchPath(directoryPath, () =>
      invalidatePermissionSourcesInDirectory(directoryPath),
    );
  }
}

export function resetPermissionLoaderCacheForTests(): void {
  permissionCache.clear();
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
}

/**
 * Load permissions from all settings files and merge them hierarchically.
 *
 * Precedence (highest to lowest):
 * 1. Local project settings (.letta/settings.local.json)
 * 2. Project settings (.letta/settings.json)
 * 3. User settings (~/.letta/settings.json)
 * 4. Legacy user settings (~/.config/letta/settings.json)
 *
 * Rules are merged by concatenating arrays (more specific settings add to broader ones)
 */
export async function loadPermissions(
  workingDirectory: string = process.cwd(),
): Promise<PermissionRules> {
  const normalizedWorkingDirectory = resolve(workingDirectory);
  const sources = getPermissionSourcePaths(normalizedWorkingDirectory);
  const signatures = getFileSignatures(sources);
  const cacheKey = normalizedWorkingDirectory;
  const cached = permissionCache.get(cacheKey);

  if (cached && cachedEntryMatchesSources(cached, sources, signatures)) {
    ensurePermissionWatchers(sources);
    return clonePermissions(cached.permissions);
  }

  const merged: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
  };

  for (const settingsPath of sources) {
    try {
      if (exists(settingsPath)) {
        const content = await readFile(settingsPath);
        const settings = JSON.parse(content) as SettingsFile;
        if (settings.permissions) {
          mergePermissions(merged, settings.permissions as PermissionRules);
        }
      }
    } catch (_error) {
      // Silently skip files that can't be parsed
      // (user might have invalid JSON)
    }
  }

  permissionCache.set(cacheKey, {
    permissions: clonePermissions(merged),
    sources,
    signatures,
  });
  ensurePermissionWatchers(sources);

  return clonePermissions(merged);
}

/**
 * Merge permission rules by concatenating arrays
 */
function mergePermissions(
  target: PermissionRules,
  source: PermissionRules,
): void {
  if (source.allow) {
    target.allow = mergeRuleList(target.allow, source.allow);
  }
  if (source.deny) {
    target.deny = mergeRuleList(target.deny, source.deny);
  }
  if (source.ask) {
    target.ask = mergeRuleList(target.ask, source.ask);
  }
  if (source.additionalDirectories) {
    target.additionalDirectories = [
      ...(target.additionalDirectories || []),
      ...source.additionalDirectories,
    ];
  }
}

function mergeRuleList(
  existing: string[] | undefined,
  incoming: string[],
): string[] {
  const merged = [...(existing || [])];
  for (const rule of incoming) {
    if (!merged.some((current) => permissionRulesEquivalent(current, rule))) {
      merged.push(rule);
    }
  }
  return merged;
}

/**
 * Save a permission rule to a specific scope
 */
export async function savePermissionRule(
  rule: string,
  ruleType: "allow" | "deny" | "ask",
  scope: "project" | "local" | "user",
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const normalizedWorkingDirectory = resolve(workingDirectory);

  // Determine settings file path based on scope
  let settingsPath: string;
  switch (scope) {
    case "user":
      settingsPath = getUserSettingsPaths().canonical;
      break;
    case "project":
      settingsPath = join(
        normalizedWorkingDirectory,
        ".letta",
        "settings.json",
      );
      break;
    case "local":
      settingsPath = join(
        normalizedWorkingDirectory,
        ".letta",
        "settings.local.json",
      );
      break;
  }

  // Load existing settings
  let settings: SettingsFile = {};
  try {
    if (exists(settingsPath)) {
      const content = await readFile(settingsPath);
      settings = JSON.parse(content) as SettingsFile;
    }
  } catch (_error) {
    // Start with empty settings if file doesn't exist or is invalid
  }

  // Initialize permissions if needed
  if (!settings.permissions) {
    settings.permissions = {};
  }
  if (!settings.permissions[ruleType]) {
    settings.permissions[ruleType] = [];
  }

  const normalizedRule = normalizePermissionRule(rule);

  // Add rule if not already present (canonicalized comparison for alias/path variants)
  if (
    !settings.permissions[ruleType].some((existingRule) =>
      permissionRulesEquivalent(existingRule, normalizedRule),
    )
  ) {
    settings.permissions[ruleType].push(normalizedRule);
  }

  // Save settings
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  invalidatePermissionSource(settingsPath);

  // If saving to .letta/settings.local.json, ensure it's gitignored
  if (scope === "local") {
    await ensureLocalSettingsIgnored(normalizedWorkingDirectory);
  }
}

/**
 * Ensure .letta/settings.local.json is in .gitignore
 */
async function ensureLocalSettingsIgnored(
  workingDirectory: string,
): Promise<void> {
  const gitignorePath = join(workingDirectory, ".gitignore");
  const pattern = ".letta/settings.local.json";

  try {
    let content = "";
    if (exists(gitignorePath)) {
      content = await readFile(gitignorePath);
    }

    // Check if pattern already exists
    if (!content.includes(pattern)) {
      // Add pattern to gitignore
      const newContent = `${
        content + (content.endsWith("\n") ? "" : "\n") + pattern
      }\n`;
      await writeFile(gitignorePath, newContent);
    }
  } catch (_error) {
    // Silently fail if we can't update .gitignore
    // (might not be a git repo)
  }
}
