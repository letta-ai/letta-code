// src/hooks/loader.ts
// Load and merge hooks from settings

import { homedir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../utils/fs";
import type { HookEventName, HookMatcher, HooksConfig } from "./types";

/**
 * Settings file that may contain hooks configuration
 */
interface SettingsWithHooks {
  hooks?: HooksConfig;
  [key: string]: unknown;
}

/**
 * Cached hooks configuration.
 * Hooks are snapshotted at startup for security (prevents runtime modification).
 */
let cachedHooksConfig: HooksConfig | null = null;
let cachedWorkingDirectory: string | null = null;

/**
 * Load hooks configuration from a settings file.
 *
 * @param filePath - Path to the settings file
 * @returns Hooks configuration or empty object if not found
 */
async function loadHooksFromFile(filePath: string): Promise<HooksConfig> {
  try {
    if (!exists(filePath)) {
      return {};
    }

    const content = await readFile(filePath);
    const settings = JSON.parse(content) as SettingsWithHooks;
    return settings.hooks || {};
  } catch {
    // File doesn't exist or is invalid - return empty config
    return {};
  }
}

/**
 * Merge multiple hooks configurations.
 * Later configurations take precedence (matchers are merged, not replaced).
 *
 * @param configs - Array of hooks configurations to merge
 * @returns Merged hooks configuration
 */
export function mergeHooksConfigs(...configs: HooksConfig[]): HooksConfig {
  const merged: HooksConfig = {};
  const eventNames: HookEventName[] = [
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "Setup",
    "SessionStart",
    "SessionEnd",
  ];

  for (const eventName of eventNames) {
    const matchers: HookMatcher[] = [];

    for (const config of configs) {
      const eventMatchers = config[eventName];
      if (eventMatchers && eventMatchers.length > 0) {
        matchers.push(...eventMatchers);
      }
    }

    if (matchers.length > 0) {
      merged[eventName] = matchers;
    }
  }

  return merged;
}

/**
 * Get paths to all settings files that may contain hooks.
 *
 * Order (lowest to highest precedence):
 * 1. User settings: ~/.letta/settings.json
 * 2. Project settings: .letta/settings.json
 * 3. Local project settings: .letta/settings.local.json
 *
 * @param workingDirectory - Current working directory
 * @returns Array of settings file paths
 */
function getSettingsFilePaths(workingDirectory: string): string[] {
  const home = process.env.HOME || homedir();
  return [
    join(home, ".letta", "settings.json"),
    join(workingDirectory, ".letta", "settings.json"),
    join(workingDirectory, ".letta", "settings.local.json"),
  ];
}

/**
 * Load and merge hooks from all settings files.
 *
 * This function loads hooks from:
 * 1. User settings (~/.letta/settings.json)
 * 2. Project settings (.letta/settings.json)
 * 3. Local project settings (.letta/settings.local.json)
 *
 * Hooks are merged with later files taking precedence.
 *
 * @param workingDirectory - Current working directory
 * @returns Merged hooks configuration
 */
export async function loadHooksConfig(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  const paths = getSettingsFilePaths(workingDirectory);
  const configs: HooksConfig[] = [];

  for (const path of paths) {
    const config = await loadHooksFromFile(path);
    configs.push(config);
  }

  return mergeHooksConfigs(...configs);
}

/**
 * Initialize the hooks system by loading and caching hooks configuration.
 * Should be called once at startup.
 *
 * @param workingDirectory - Current working directory
 */
export async function initializeHooks(
  workingDirectory: string = process.cwd(),
): Promise<void> {
  cachedHooksConfig = await loadHooksConfig(workingDirectory);
  cachedWorkingDirectory = workingDirectory;
}

/**
 * Get the cached hooks configuration.
 * Returns empty config if hooks haven't been initialized.
 *
 * @returns Cached hooks configuration
 */
export function getHooksConfig(): HooksConfig {
  return cachedHooksConfig || {};
}

/**
 * Get hooks for a specific event.
 *
 * @param eventName - Name of the hook event
 * @returns Array of hook matchers for the event, or undefined
 */
export function getEventHooks(
  eventName: HookEventName,
): HookMatcher[] | undefined {
  const config = getHooksConfig();
  return config[eventName];
}

/**
 * Check if hooks are configured for a specific event.
 *
 * @param eventName - Name of the hook event
 * @returns true if any hooks are configured for the event
 */
export function hasEventHooks(eventName: HookEventName): boolean {
  const matchers = getEventHooks(eventName);
  return Boolean(matchers && matchers.length > 0);
}

/**
 * Reset the hooks cache.
 * Useful for testing or when settings change.
 */
export function resetHooksCache(): void {
  cachedHooksConfig = null;
  cachedWorkingDirectory = null;
}

/**
 * Reload hooks configuration from disk.
 * Useful when settings have been modified.
 *
 * @param workingDirectory - Current working directory (defaults to cached or cwd)
 */
export async function reloadHooksConfig(
  workingDirectory?: string,
): Promise<void> {
  const dir = workingDirectory || cachedWorkingDirectory || process.cwd();
  await initializeHooks(dir);
}

/**
 * Check if the working directory has changed since hooks were loaded.
 * Used to detect when hooks should be reloaded.
 *
 * @param workingDirectory - Current working directory
 * @returns true if the working directory has changed
 */
export function hasWorkingDirectoryChanged(
  workingDirectory: string = process.cwd(),
): boolean {
  return (
    cachedWorkingDirectory !== null &&
    cachedWorkingDirectory !== workingDirectory
  );
}
