// src/hooks/writer.ts
// Functions to write hooks to settings files via settings-manager

import { settingsManager } from "../settings-manager";
import type { HookEvent, HookMatcher, HooksConfig } from "./types";

/**
 * Save location for hooks
 */
export type SaveLocation = "user" | "project" | "project-local";

/**
 * Load hooks config from a specific location
 */
export function loadHooksFromLocation(
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): HooksConfig {
  try {
    switch (location) {
      case "user":
        return settingsManager.getSettings().hooks || {};
      case "project":
        return (
          settingsManager.getProjectSettings(workingDirectory)?.hooks || {}
        );
      case "project-local":
        return (
          settingsManager.getLocalProjectSettings(workingDirectory)?.hooks || {}
        );
    }
  } catch {
    // Settings not loaded yet, return empty
    return {};
  }
}

/**
 * Save hooks config to a specific location
 * Note: This is async because it may need to load settings first
 */
export async function saveHooksToLocation(
  hooks: HooksConfig,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  // Ensure settings are loaded before updating
  switch (location) {
    case "user":
      settingsManager.updateSettings({ hooks });
      break;
    case "project":
      // Load project settings if not already loaded
      try {
        settingsManager.getProjectSettings(workingDirectory);
      } catch {
        await settingsManager.loadProjectSettings(workingDirectory);
      }
      settingsManager.updateProjectSettings({ hooks }, workingDirectory);
      break;
    case "project-local":
      // Load local project settings if not already loaded
      try {
        settingsManager.getLocalProjectSettings(workingDirectory);
      } catch {
        await settingsManager.loadLocalProjectSettings(workingDirectory);
      }
      settingsManager.updateLocalProjectSettings({ hooks }, workingDirectory);
      break;
  }
  // No need to clear cache - settings-manager IS the cache
}

/**
 * Add a new hook matcher to an event
 */
export async function addHookMatcher(
  event: HookEvent,
  matcher: HookMatcher,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);

  // Initialize event array if needed
  if (!hooks[event]) {
    hooks[event] = [];
  }

  // Add the new matcher
  const eventMatchers = hooks[event];
  if (eventMatchers) {
    eventMatchers.push(matcher);
  }

  await saveHooksToLocation(hooks, location, workingDirectory);
}

/**
 * Remove a hook matcher from an event by index
 */
export async function removeHookMatcher(
  event: HookEvent,
  matcherIndex: number,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);
  const eventMatchers = hooks[event];

  if (
    !eventMatchers ||
    matcherIndex < 0 ||
    matcherIndex >= eventMatchers.length
  ) {
    throw new Error(`Invalid matcher index ${matcherIndex} for event ${event}`);
  }

  // Remove the matcher at the given index
  eventMatchers.splice(matcherIndex, 1);

  // Clean up empty arrays
  if (eventMatchers.length === 0) {
    delete hooks[event];
  }

  await saveHooksToLocation(hooks, location, workingDirectory);
}

/**
 * Update a hook matcher at a specific index
 */
export async function updateHookMatcher(
  event: HookEvent,
  matcherIndex: number,
  matcher: HookMatcher,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);
  const eventMatchers = hooks[event];

  if (
    !eventMatchers ||
    matcherIndex < 0 ||
    matcherIndex >= eventMatchers.length
  ) {
    throw new Error(`Invalid matcher index ${matcherIndex} for event ${event}`);
  }

  // Update the matcher at the given index
  eventMatchers[matcherIndex] = matcher;

  await saveHooksToLocation(hooks, location, workingDirectory);
}

/**
 * Hook matcher with source tracking for display
 */
export interface HookMatcherWithSource extends HookMatcher {
  source: SaveLocation;
  sourceIndex: number; // Index within that source file
}

/**
 * Load all hooks for an event with source tracking
 * Returns matchers tagged with their source location
 */
export function loadHooksWithSource(
  event: HookEvent,
  workingDirectory: string = process.cwd(),
): HookMatcherWithSource[] {
  const result: HookMatcherWithSource[] = [];

  // Load from each location and tag with source
  const locations: SaveLocation[] = ["project-local", "project", "user"];

  for (const location of locations) {
    const hooks = loadHooksFromLocation(location, workingDirectory);
    const matchers = hooks[event] || [];

    for (let i = 0; i < matchers.length; i++) {
      const matcher = matchers[i];
      if (matcher) {
        result.push({
          ...matcher,
          source: location,
          sourceIndex: i,
        });
      }
    }
  }

  return result;
}

/**
 * Count total hooks across all events and locations
 */
export function countTotalHooks(
  workingDirectory: string = process.cwd(),
): number {
  let count = 0;

  const locations: SaveLocation[] = ["project-local", "project", "user"];

  for (const location of locations) {
    const hooks = loadHooksFromLocation(location, workingDirectory);
    for (const event of Object.keys(hooks) as HookEvent[]) {
      const matchers = hooks[event] || [];
      for (const matcher of matchers) {
        count += matcher.hooks.length;
      }
    }
  }

  return count;
}

/**
 * Count hooks for a specific event across all locations
 */
export function countHooksForEvent(
  event: HookEvent,
  workingDirectory: string = process.cwd(),
): number {
  let count = 0;

  const locations: SaveLocation[] = ["project-local", "project", "user"];

  for (const location of locations) {
    const hooks = loadHooksFromLocation(location, workingDirectory);
    const matchers = hooks[event] || [];
    for (const matcher of matchers) {
      count += matcher.hooks.length;
    }
  }

  return count;
}
