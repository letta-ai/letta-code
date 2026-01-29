// src/hooks/writer.ts
// Functions to write hooks to settings files via settings-manager

import { settingsManager } from "../settings-manager";
import {
  type HookEvent,
  type HookMatcher,
  type HooksConfig,
  isToolEvent,
  type SimpleHookEvent,
  type SimpleHookMatcher,
  type ToolHookEvent,
} from "./types";

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
}

/**
 * Add a new hook matcher to a tool event (PreToolUse, PostToolUse, PermissionRequest)
 */
export async function addHookMatcher(
  event: ToolHookEvent,
  matcher: HookMatcher,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);

  // Initialize event array if needed
  if (!hooks[event]) {
    (hooks as Record<ToolHookEvent, HookMatcher[]>)[event] = [];
  }

  // Add the new matcher
  const eventMatchers = hooks[event] as HookMatcher[];
  eventMatchers.push(matcher);

  await saveHooksToLocation(hooks, location, workingDirectory);
}

/**
 * Add a new hook matcher to a simple event (non-tool events)
 * Simple events use the same structure as tool events but without the matcher field
 */
export async function addSimpleHookMatcher(
  event: SimpleHookEvent,
  matcher: SimpleHookMatcher,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);

  // Initialize event array if needed
  if (!hooks[event]) {
    (hooks as Record<SimpleHookEvent, SimpleHookMatcher[]>)[event] = [];
  }

  // Add the new matcher
  const eventMatchers = hooks[event] as SimpleHookMatcher[];
  eventMatchers.push(matcher);

  await saveHooksToLocation(hooks, location, workingDirectory);
}

/**
 * Remove a hook matcher from an event by index
 * Works for both tool events (HookMatcher) and simple events (SimpleHookMatcher)
 */
export async function removeHook(
  event: HookEvent,
  index: number,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);

  if (isToolEvent(event)) {
    const eventMatchers = hooks[event as ToolHookEvent] as
      | HookMatcher[]
      | undefined;
    if (!eventMatchers || index < 0 || index >= eventMatchers.length) {
      throw new Error(`Invalid matcher index ${index} for event ${event}`);
    }
    eventMatchers.splice(index, 1);
    if (eventMatchers.length === 0) {
      delete hooks[event as ToolHookEvent];
    }
  } else {
    const eventMatchers = hooks[event as SimpleHookEvent] as
      | SimpleHookMatcher[]
      | undefined;
    if (!eventMatchers || index < 0 || index >= eventMatchers.length) {
      throw new Error(`Invalid matcher index ${index} for event ${event}`);
    }
    eventMatchers.splice(index, 1);
    if (eventMatchers.length === 0) {
      delete hooks[event as SimpleHookEvent];
    }
  }

  await saveHooksToLocation(hooks, location, workingDirectory);
}

/**
 * Update a hook matcher at a specific index (tool events only)
 */
export async function updateHookMatcher(
  event: ToolHookEvent,
  matcherIndex: number,
  matcher: HookMatcher,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);
  const eventMatchers = hooks[event] as HookMatcher[] | undefined;

  if (
    !eventMatchers ||
    matcherIndex < 0 ||
    matcherIndex >= eventMatchers.length
  ) {
    throw new Error(`Invalid matcher index ${matcherIndex} for event ${event}`);
  }

  eventMatchers[matcherIndex] = matcher;

  await saveHooksToLocation(hooks, location, workingDirectory);
}

/**
 * Update a hook matcher at a specific index (simple events only)
 */
export async function updateSimpleHookMatcher(
  event: SimpleHookEvent,
  matcherIndex: number,
  matcher: SimpleHookMatcher,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);
  const eventMatchers = hooks[event] as SimpleHookMatcher[] | undefined;

  if (
    !eventMatchers ||
    matcherIndex < 0 ||
    matcherIndex >= eventMatchers.length
  ) {
    throw new Error(`Invalid matcher index ${matcherIndex} for event ${event}`);
  }

  eventMatchers[matcherIndex] = matcher;

  await saveHooksToLocation(hooks, location, workingDirectory);
}

/**
 * Hook matcher with source tracking for display (tool events)
 */
export interface HookMatcherWithSource extends HookMatcher {
  source: SaveLocation;
  sourceIndex: number; // Index within that source file
}

/**
 * Simple hook matcher with source tracking for display (simple events)
 */
export interface SimpleHookMatcherWithSource extends SimpleHookMatcher {
  source: SaveLocation;
  sourceIndex: number; // Index within that source file
}

/**
 * Union type for hooks with source tracking
 */
export type HookWithSource =
  | HookMatcherWithSource
  | SimpleHookMatcherWithSource;

/**
 * Load all hook matchers for a tool event with source tracking
 */
export function loadMatchersWithSource(
  event: ToolHookEvent,
  workingDirectory: string = process.cwd(),
): HookMatcherWithSource[] {
  const result: HookMatcherWithSource[] = [];
  const locations: SaveLocation[] = ["project-local", "project", "user"];

  for (const location of locations) {
    const hooks = loadHooksFromLocation(location, workingDirectory);
    const matchers = (hooks[event] || []) as HookMatcher[];

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
 * Load all hook matchers for a simple event with source tracking
 */
export function loadSimpleMatchersWithSource(
  event: SimpleHookEvent,
  workingDirectory: string = process.cwd(),
): SimpleHookMatcherWithSource[] {
  const result: SimpleHookMatcherWithSource[] = [];
  const locations: SaveLocation[] = ["project-local", "project", "user"];

  for (const location of locations) {
    const hooks = loadHooksFromLocation(location, workingDirectory);
    const matchers = (hooks[event] || []) as SimpleHookMatcher[];

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
    for (const key of Object.keys(hooks)) {
      // Skip non-event keys like 'disabled'
      if (key === "disabled") continue;

      const event = key as HookEvent;
      if (isToolEvent(event)) {
        // Tool events have HookMatcher[] with nested hooks
        const matchers = (hooks[event as ToolHookEvent] || []) as HookMatcher[];
        for (const matcher of matchers) {
          count += matcher.hooks.length;
        }
      } else {
        // Simple events have SimpleHookMatcher[] with nested hooks
        const matchers = (hooks[event as SimpleHookEvent] ||
          []) as SimpleHookMatcher[];
        for (const matcher of matchers) {
          count += matcher.hooks.length;
        }
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
    if (isToolEvent(event)) {
      // Tool events have HookMatcher[] with nested hooks
      const matchers = (hooks[event as ToolHookEvent] || []) as HookMatcher[];
      for (const matcher of matchers) {
        count += matcher.hooks.length;
      }
    } else {
      // Simple events have SimpleHookMatcher[] with nested hooks
      const matchers = (hooks[event as SimpleHookEvent] ||
        []) as SimpleHookMatcher[];
      for (const matcher of matchers) {
        count += matcher.hooks.length;
      }
    }
  }

  return count;
}

/**
 * Check if user-level hooks.disabled is set to true.
 * NOTE: This only checks user settings. For full precedence logic
 * (user → project → project-local), use areHooksDisabled from loader.ts.
 */
export function isUserHooksDisabled(): boolean {
  try {
    return settingsManager.getSettings().hooks?.disabled === true;
  } catch {
    return false;
  }
}

/**
 * Set whether all hooks are disabled (writes to user-level hooks.disabled)
 */
export function setHooksDisabled(disabled: boolean): void {
  const currentHooks = settingsManager.getSettings().hooks || {};
  settingsManager.updateSettings({
    hooks: {
      ...currentHooks,
      disabled,
    },
  });
}
