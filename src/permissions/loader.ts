import { exists, readFile, writeFile } from "../utils/fs.js";
// src/permissions/loader.ts
// Load and merge permission settings from hierarchical sources

import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionRules } from "./types";

type SettingsFile = {
  permissions?: Record<string, string[]>;
  [key: string]: unknown;
};

/**
 * Load permissions from all settings files and merge them hierarchically.
 *
 * Precedence (highest to lowest):
 * 1. Local project settings (.letta/settings.local.json)
 * 2. Project settings (.letta/settings.json)
 * 3. User settings (~/.letta/settings.json)
 *
 * Rules are merged by concatenating arrays (more specific settings add to broader ones)
 */
export async function loadPermissions(
  workingDirectory: string = process.cwd(),
): Promise<PermissionRules> {
  const merged: PermissionRules = {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
  };

  // Load in reverse precedence order (lowest to highest)
  const sources = [
    join(homedir(), ".letta", "settings.json"), // User
    join(workingDirectory, ".letta", "settings.json"), // Project
    join(workingDirectory, ".letta", "settings.local.json"), // Local
  ];

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

  return merged;
}

/**
 * Merge permission rules by concatenating arrays
 */
function mergePermissions(
  target: PermissionRules,
  source: PermissionRules,
): void {
  if (source.allow) {
    target.allow = [...(target.allow || []), ...source.allow];
  }
  if (source.deny) {
    target.deny = [...(target.deny || []), ...source.deny];
  }
  if (source.ask) {
    target.ask = [...(target.ask || []), ...source.ask];
  }
  if (source.additionalDirectories) {
    target.additionalDirectories = [
      ...(target.additionalDirectories || []),
      ...source.additionalDirectories,
    ];
  }
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
  // Determine settings file path based on scope
  let settingsPath: string;
  switch (scope) {
    case "user":
      settingsPath = join(homedir(), ".letta", "settings.json");
      break;
    case "project":
      settingsPath = join(workingDirectory, ".letta", "settings.json");
      break;
    case "local":
      settingsPath = join(workingDirectory, ".letta", "settings.local.json");
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

  // Add rule if not already present
  if (!settings.permissions[ruleType].includes(rule)) {
    settings.permissions[ruleType].push(rule);
  }

  // Save settings
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  // If saving to .letta/settings.local.json, ensure it's gitignored
  if (scope === "local") {
    await ensureLocalSettingsIgnored(workingDirectory);
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
