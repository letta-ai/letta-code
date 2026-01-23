// src/hooks/loader.ts
// Loads and matches hooks from settings-manager

import { settingsManager } from "../settings-manager";
import type { HookCommand, HookEvent, HooksConfig } from "./types";

/**
 * Clear hooks cache - kept for API compatibility with existing callers.
 */
export function clearHooksCache(): void {
  // Settings-manager handles caching
}

/**
 * Load global hooks configuration from ~/.letta/settings.json
 * Uses settings-manager cache (loaded at app startup)
 */
export function loadGlobalHooks(): HooksConfig {
  try {
    return settingsManager.getSettings().hooks || {};
  } catch {
    // Settings not initialized yet
    return {};
  }
}

/**
 * Load project hooks configuration from .letta/settings.json
 * Uses settings-manager cache
 */
export async function loadProjectHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  try {
    // Ensure project settings are loaded
    try {
      settingsManager.getProjectSettings(workingDirectory);
    } catch {
      await settingsManager.loadProjectSettings(workingDirectory);
    }
    return settingsManager.getProjectSettings(workingDirectory)?.hooks || {};
  } catch {
    // Settings not available
    return {};
  }
}

/**
 * Load project-local hooks configuration from .letta/settings.local.json
 * Uses settings-manager cache
 */
export async function loadProjectLocalHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  try {
    // Ensure local project settings are loaded
    try {
      settingsManager.getLocalProjectSettings(workingDirectory);
    } catch {
      await settingsManager.loadLocalProjectSettings(workingDirectory);
    }
    return (
      settingsManager.getLocalProjectSettings(workingDirectory)?.hooks || {}
    );
  } catch {
    // Settings not available
    return {};
  }
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
    Promise.resolve(loadGlobalHooks()),
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
