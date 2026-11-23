import { settingsManager } from "@/settings-manager";
import { debugLog } from "@/utils/debug";
import { isProjectSettingsPathGlobal } from "@/utils/settings-path";
import {
  type HookCommand,
  type HookEvent,
  type HookMatcher,
  type HooksConfig,
  isPromptHook,
  isToolEvent,
  type SimpleHookEvent,
  type SimpleHookMatcher,
  supportsPromptHooks,
  type ToolHookEvent,
} from "./types";

export function clearHooksCache(): void {}

function isProjectSettingsPathCollidingWithGlobal(
  workingDirectory: string,
): boolean {
  return isProjectSettingsPathGlobal(workingDirectory);
}

export function loadGlobalHooks(): HooksConfig {
  try {
    return settingsManager.getSettings().hooks || {};
  } catch (error) {
    debugLog("hooks", "loadGlobalHooks: Settings not initialized yet", error);
    return {};
  }
}

export async function loadProjectHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  if (isProjectSettingsPathCollidingWithGlobal(workingDirectory)) {
    return {};
  }

  try {
    try {
      settingsManager.getProjectSettings(workingDirectory);
    } catch {
      await settingsManager.loadProjectSettings(workingDirectory);
    }
    return settingsManager.getProjectSettings(workingDirectory)?.hooks || {};
  } catch (error) {
    debugLog("hooks", "loadProjectHooks: Settings not available", error);
    return {};
  }
}

export async function loadProjectLocalHooks(
  workingDirectory: string = process.cwd(),
): Promise<HooksConfig> {
  try {
    try {
      settingsManager.getLocalProjectSettings(workingDirectory);
    } catch {
      await settingsManager.loadLocalProjectSettings(workingDirectory);
    }
    return (
      settingsManager.getLocalProjectSettings(workingDirectory)?.hooks || {}
    );
  } catch (error) {
    debugLog("hooks", "loadProjectLocalHooks: Settings not available", error);
    return {};
  }
}

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
    if (isToolEvent(event)) {
      const toolEvent = event as ToolHookEvent;
      const globalMatchers = (global[toolEvent] || []) as HookMatcher[];
      const projectMatchers = (project[toolEvent] || []) as HookMatcher[];
      const projectLocalMatchers = (projectLocal[toolEvent] ||
        []) as HookMatcher[];
      (merged as Record<ToolHookEvent, HookMatcher[]>)[toolEvent] = [
        ...projectLocalMatchers,
        ...projectMatchers,
        ...globalMatchers,
      ];
    } else {
      const simpleEvent = event as SimpleHookEvent;
      const globalMatchers = (global[simpleEvent] || []) as SimpleHookMatcher[];
      const projectMatchers = (project[simpleEvent] ||
        []) as SimpleHookMatcher[];
      const projectLocalMatchers = (projectLocal[simpleEvent] ||
        []) as SimpleHookMatcher[];
      (merged as Record<SimpleHookEvent, SimpleHookMatcher[]>)[simpleEvent] = [
        ...projectLocalMatchers,
        ...projectMatchers,
        ...globalMatchers,
      ];
    }
  }

  return merged;
}

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

export function matchesTool(pattern: string, toolName: string): boolean {
  if (!pattern || pattern === "*") {
    return true;
  }

  try {
    const regex = new RegExp(`^(?:${pattern})$`);
    return regex.test(toolName);
  } catch (error) {
    debugLog(
      "hooks",
      `matchesTool: Invalid regex pattern "${pattern}", falling back to exact match`,
      error,
    );
    return pattern === toolName;
  }
}

function filterHooksForEvent(
  hooks: HookCommand[],
  event: HookEvent,
): HookCommand[] {
  const filtered: HookCommand[] = [];
  const promptHooksSupported = supportsPromptHooks(event);

  for (const hook of hooks) {
    if (isPromptHook(hook)) {
      if (!promptHooksSupported) {
        console.warn(
          `\x1b[33m[hooks] Warning: Prompt hooks are not supported for the ${event} event. ` +
            `Ignoring prompt hook.\x1b[0m`,
        );
        continue;
      }
    }
    filtered.push(hook);
  }

  return filtered;
}

export function getMatchingHooks(
  config: HooksConfig,
  event: HookEvent,
  toolName?: string,
): HookCommand[] {
  if (isToolEvent(event)) {
    const matchers = config[event as ToolHookEvent] as
      | HookMatcher[]
      | undefined;
    if (!matchers || matchers.length === 0) {
      return [];
    }

    const hooks: HookCommand[] = [];
    for (const matcher of matchers) {
      if (!toolName || matchesTool(matcher.matcher, toolName)) {
        hooks.push(...matcher.hooks);
      }
    }
    return filterHooksForEvent(hooks, event);
  } else {
    const matchers = config[event as SimpleHookEvent] as
      | SimpleHookMatcher[]
      | undefined;
    if (!matchers || matchers.length === 0) {
      return [];
    }

    const hooks: HookCommand[] = [];
    for (const matcher of matchers) {
      hooks.push(...matcher.hooks);
    }
    return filterHooksForEvent(hooks, event);
  }
}

export function hasHooksForEvent(
  config: HooksConfig,
  event: HookEvent,
): boolean {
  if (isToolEvent(event)) {
    const matchers = config[event as ToolHookEvent] as
      | HookMatcher[]
      | undefined;
    if (!matchers || matchers.length === 0) {
      return false;
    }
    return matchers.some((m) => m.hooks && m.hooks.length > 0);
  } else {
    const matchers = config[event as SimpleHookEvent] as
      | SimpleHookMatcher[]
      | undefined;
    if (!matchers || matchers.length === 0) {
      return false;
    }
    return matchers.some((m) => m.hooks && m.hooks.length > 0);
  }
}

export function areHooksDisabled(
  workingDirectory: string = process.cwd(),
): boolean {
  try {
    const userDisabled = settingsManager.getSettings().hooks?.disabled;
    if (userDisabled === false) {
      return false;
    }
    if (userDisabled === true) {
      return true;
    }

    try {
      const projectDisabled =
        settingsManager.getProjectSettings(workingDirectory)?.hooks?.disabled;
      if (projectDisabled === true) {
        return true;
      }
    } catch {
      debugLog(
        "hooks",
        "areHooksDisabled: Project settings not loaded, skipping",
      );
    }

    try {
      const localDisabled =
        settingsManager.getLocalProjectSettings(workingDirectory)?.hooks
          ?.disabled;
      if (localDisabled === true) {
        return true;
      }
    } catch {
      debugLog(
        "hooks",
        "areHooksDisabled: Local project settings not loaded, skipping",
      );
    }

    return false;
  } catch {
    debugLog(
      "hooks",
      "areHooksDisabled: Failed to check hooks disabled status",
    );
    return false;
  }
}

export async function getHooksForEvent(
  event: HookEvent,
  toolName?: string,
  workingDirectory: string = process.cwd(),
): Promise<HookCommand[]> {
  if (areHooksDisabled(workingDirectory)) {
    return [];
  }

  const config = await loadHooks(workingDirectory);
  return getMatchingHooks(config, event, toolName);
}
