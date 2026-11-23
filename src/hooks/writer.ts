import { settingsManager } from "@/settings-manager";
import { debugLog } from "@/utils/debug";
import { isProjectSettingsPathGlobal } from "@/utils/settings-path";
import {
  type HookEvent,
  type HookMatcher,
  type HooksConfig,
  isToolEvent,
  type SimpleHookEvent,
  type SimpleHookMatcher,
  type ToolHookEvent,
} from "./types";

export type SaveLocation = "user" | "project" | "project-local";

function isProjectSettingsPathCollidingWithGlobal(
  workingDirectory: string,
): boolean {
  return isProjectSettingsPathGlobal(workingDirectory);
}

export function loadHooksFromLocation(
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): HooksConfig {
  try {
    switch (location) {
      case "user":
        return settingsManager.getSettings().hooks || {};
      case "project":
        if (isProjectSettingsPathCollidingWithGlobal(workingDirectory)) {
          return {};
        }
        return (
          settingsManager.getProjectSettings(workingDirectory)?.hooks || {}
        );
      case "project-local":
        return (
          settingsManager.getLocalProjectSettings(workingDirectory)?.hooks || {}
        );
    }
  } catch (error) {
    debugLog("hooks", "loadHooksFromLocation: Settings not loaded yet", error);
    return {};
  }
}

export async function saveHooksToLocation(
  hooks: HooksConfig,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  switch (location) {
    case "user":
      settingsManager.updateSettings({ hooks });
      break;
    case "project":
      if (isProjectSettingsPathCollidingWithGlobal(workingDirectory)) {
        settingsManager.updateSettings({ hooks });
        break;
      }

      try {
        settingsManager.getProjectSettings(workingDirectory);
      } catch {
        await settingsManager.loadProjectSettings(workingDirectory);
      }
      settingsManager.updateProjectSettings({ hooks }, workingDirectory);
      break;
    case "project-local":
      try {
        settingsManager.getLocalProjectSettings(workingDirectory);
      } catch {
        await settingsManager.loadLocalProjectSettings(workingDirectory);
      }
      settingsManager.updateLocalProjectSettings({ hooks }, workingDirectory);
      break;
  }
}

export async function addHookMatcher(
  event: ToolHookEvent,
  matcher: HookMatcher,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);

  if (!hooks[event]) {
    (hooks as Record<ToolHookEvent, HookMatcher[]>)[event] = [];
  }

  const eventMatchers = hooks[event] as HookMatcher[];
  eventMatchers.push(matcher);

  await saveHooksToLocation(hooks, location, workingDirectory);
}

export async function addSimpleHookMatcher(
  event: SimpleHookEvent,
  matcher: SimpleHookMatcher,
  location: SaveLocation,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const hooks = loadHooksFromLocation(location, workingDirectory);

  if (!hooks[event]) {
    (hooks as Record<SimpleHookEvent, SimpleHookMatcher[]>)[event] = [];
  }

  const eventMatchers = hooks[event] as SimpleHookMatcher[];
  eventMatchers.push(matcher);

  await saveHooksToLocation(hooks, location, workingDirectory);
}

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

export interface HookMatcherWithSource extends HookMatcher {
  source: SaveLocation;
  sourceIndex: number;
}

export interface SimpleHookMatcherWithSource extends SimpleHookMatcher {
  source: SaveLocation;
  sourceIndex: number;
}

export type HookWithSource =
  | HookMatcherWithSource
  | SimpleHookMatcherWithSource;

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

export function countTotalHooks(
  workingDirectory: string = process.cwd(),
): number {
  let count = 0;

  const locations: SaveLocation[] = ["project-local", "project", "user"];

  for (const location of locations) {
    const hooks = loadHooksFromLocation(location, workingDirectory);
    for (const key of Object.keys(hooks)) {
      if (key === "disabled") continue;

      const event = key as HookEvent;
      if (isToolEvent(event)) {
        const matchers = (hooks[event as ToolHookEvent] || []) as HookMatcher[];
        for (const matcher of matchers) {
          count += matcher.hooks.length;
        }
      } else {
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

export function countHooksForEvent(
  event: HookEvent,
  workingDirectory: string = process.cwd(),
): number {
  let count = 0;

  const locations: SaveLocation[] = ["project-local", "project", "user"];

  for (const location of locations) {
    const hooks = loadHooksFromLocation(location, workingDirectory);
    if (isToolEvent(event)) {
      const matchers = (hooks[event as ToolHookEvent] || []) as HookMatcher[];
      for (const matcher of matchers) {
        count += matcher.hooks.length;
      }
    } else {
      const matchers = (hooks[event as SimpleHookEvent] ||
        []) as SimpleHookMatcher[];
      for (const matcher of matchers) {
        count += matcher.hooks.length;
      }
    }
  }

  return count;
}

export function isUserHooksDisabled(): boolean {
  try {
    return settingsManager.getSettings().hooks?.disabled === true;
  } catch (error) {
    debugLog(
      "hooks",
      "isUserHooksDisabled: Failed to check user hooks disabled status",
      error,
    );
    return false;
  }
}

export function setHooksDisabled(disabled: boolean): void {
  const currentHooks = settingsManager.getSettings().hooks || {};
  settingsManager.updateSettings({
    hooks: {
      ...currentHooks,
      disabled,
    },
  });
}
