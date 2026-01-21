// src/hooks/loader.ts
// Loads and matches hooks from settings

import { homedir } from "node:os";
import { join } from "node:path";
import { exists, readFile } from "../utils/fs.js";
import type { HookCommand, HookEvent, HookMatcher, HooksConfig } from "./types";

/**
 * Cache for loaded hooks configurations
 */
let globalHooksCache: HooksConfig | null = null;
const projectHooksCache: Map<string, HooksConfig> = new Map();
const projectLocalHooksCache: Map<string, HooksConfig> = new Map();

/**
 * Clear hooks cache (useful for testing or when settings change)
 */
export function clearHooksCache(): void {
  globalHooksCache = null;
  projectHooksCache.clear();
  projectLocalHooksCache.clear();
}

/**
 * Get the path to global hooks settings
 */
function getGlobalSettingsPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".letta", "settings.json");
}

/**
 * Get the path to project hooks settings
 */
function getProjectSettingsPath(workingDirectory: string): string {
  return join(workingDirectory, ".letta", "settings.json");
}

/**
 * Get the path to project-local hooks settings (gitignored)
 */
function getProjectLocalSettingsPath(workingDirectory: string): string {
  return join(workingDirectory, ".letta", "settings.local.json");
}

/**
 * Load hooks configuration from a settings file
 */
async function loadHooksFromFile(path: string): Promise<HooksConfig | null> {
  if (!exists(path)) {
    return null;
  }

  try {
    const content = await readFile(path);
    const settings = JSON.parse(content) as { hooks?: HooksConfig };
    return settings.hooks || null;
  } catch (error) {
    // Silently ignore parse errors - don't break the app for bad hooks config
    console.warn(`Failed to load hooks from ${path}:`, error);
    return null;
  }
}

/**
 * Load global hooks configuration from ~/.letta/settings.json
 */
export async function loadGlobalHooks(): Promise<HooksConfig> {
  if (globalHooksCache !== null) {
    return globalHooksCache;
  }

  const path = getGlobalSettingsPath();
  const hooks = await loadHooksFromFile(path);
  globalHooksCache = hooks || {};
  return globalHooksCache;
}

/**
 * Load project hooks configuration from .letta/settings.json
 */
export async function loadProjectHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  const cached = projectHooksCache.get(workingDirectory);
  if (cached !== undefined) {
    return cached;
  }

  const path = getProjectSettingsPath(workingDirectory);
  const hooks = await loadHooksFromFile(path);
  const result = hooks || {};
  projectHooksCache.set(workingDirectory, result);
  return result;
}

/**
 * Load project-local hooks configuration from .letta/settings.local.json
 */
export async function loadProjectLocalHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  const cached = projectLocalHooksCache.get(workingDirectory);
  if (cached !== undefined) {
    return cached;
  }

  const path = getProjectLocalSettingsPath(workingDirectory);
  const hooks = await loadHooksFromFile(path);
  const result = hooks || {};
  projectLocalHooksCache.set(workingDirectory, result);
  return result;
}

/**
 * Merge hooks configurations
 * Priority order: project-local > project > global
 * For each event, matchers are ordered by priority (local first, global last)
 */
export function mergeHooksConfigs(
  global: HooksConfig,
  project: HooksConfig,
  projectLocal: HooksConfig = {},
): HooksConfig {
  const merged: HooksConfig = {};
  const allEvents = new Set([
    ...Object.keys(global),
    ...Object.keys(project),
    ...Object.keys(projectLocal),
  ]) as Set<HookEvent>;

  for (const event of allEvents) {
    const globalMatchers = global[event] || [];
    const projectMatchers = project[event] || [];
    const projectLocalMatchers = projectLocal[event] || [];
    // Project-local matchers run first, then project, then global
    merged[event] = [
      ...projectLocalMatchers,
      ...projectMatchers,
      ...globalMatchers,
    ];
  }

  return merged;
}

/**
 * Load merged hooks configuration (global + project + project-local)
 */
export async function loadHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  const [global, project, projectLocal] = await Promise.all([
    loadGlobalHooks(),
    loadProjectHooks(workingDirectory),
    loadProjectLocalHooks(workingDirectory),
  ]);

  return mergeHooksConfigs(global, project, projectLocal);
}

/**
 * Check if a tool name matches a matcher pattern
 * Patterns:
 * - "*" or "": matches all tools
 * - "ToolName": exact match
 * - "Tool1|Tool2|Tool3": matches any of the listed tools
 */
export function matchesTool(pattern: string, toolName: string): boolean {
  // Empty or "*" matches everything
  if (!pattern || pattern === "*") {
    return true;
  }

  // Check for pipe-separated list
  if (pattern.includes("|")) {
    const tools = pattern.split("|").map((t) => t.trim());
    return tools.includes(toolName);
  }

  // Exact match
  return pattern === toolName;
}

/**
 * Get all hooks that match a specific event and tool name
 */
export function getMatchingHooks(
  config: HooksConfig,
  event: HookEvent,
  toolName?: string,
): HookCommand[] {
  const matchers = config[event];
  if (!matchers || matchers.length === 0) {
    return [];
  }

  const hooks: HookCommand[] = [];

  for (const matcher of matchers) {
    // For non-tool events, matcher is usually empty/"*"
    // For tool events, check if the tool matches
    if (!toolName || matchesTool(matcher.matcher, toolName)) {
      hooks.push(...matcher.hooks);
    }
  }

  return hooks;
}

/**
 * Check if there are any hooks configured for a specific event
 */
export function hasHooksForEvent(
  config: HooksConfig,
  event: HookEvent,
): boolean {
  const matchers = config[event];
  if (!matchers || matchers.length === 0) {
    return false;
  }

  // Check if any matcher has hooks
  return matchers.some((m) => m.hooks && m.hooks.length > 0);
}

/**
 * Convenience function to load hooks and get matching ones for an event
 */
export async function getHooksForEvent(
  event: HookEvent,
  toolName?: string,
  workingDirectory: string = process.cwd(),
): Promise<HookCommand[]> {
  const config = await loadHooks(workingDirectory);
  return getMatchingHooks(config, event, toolName);
}
