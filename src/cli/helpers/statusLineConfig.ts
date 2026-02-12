// Config resolution for user-defined status line commands.
// Precedence: local project > project > global settings.

import type { StatusLineConfig } from "../../settings-manager";
import { settingsManager } from "../../settings-manager";
import { debugLog } from "../../utils/debug";

/** Minimum allowed polling interval (1 second). */
export const MIN_STATUS_LINE_INTERVAL_MS = 1_000;

/** Default execution timeout (5 seconds). */
export const DEFAULT_STATUS_LINE_TIMEOUT_MS = 5_000;

/** Maximum allowed execution timeout (30 seconds). */
export const MAX_STATUS_LINE_TIMEOUT_MS = 30_000;

/** Default trigger debounce (300ms). */
export const DEFAULT_STATUS_LINE_DEBOUNCE_MS = 300;

/** Minimum allowed debounce. */
export const MIN_STATUS_LINE_DEBOUNCE_MS = 50;

/** Maximum allowed debounce. */
export const MAX_STATUS_LINE_DEBOUNCE_MS = 5_000;

/** Maximum allowed padding. */
export const MAX_STATUS_LINE_PADDING = 16;

export interface NormalizedStatusLineConfig {
  type: "command";
  command: string;
  padding: number;
  timeout: number;
  debounceMs: number;
  refreshIntervalMs?: number;
  disabled?: boolean;
}

/**
 * Clamp status line config to valid ranges and fill defaults.
 */
export function normalizeStatusLineConfig(
  config: StatusLineConfig,
): NormalizedStatusLineConfig {
  const refreshIntervalMs =
    config.refreshIntervalMs === undefined
      ? undefined
      : Math.max(MIN_STATUS_LINE_INTERVAL_MS, config.refreshIntervalMs);

  return {
    type: "command",
    command: config.command,
    padding: Math.max(
      0,
      Math.min(MAX_STATUS_LINE_PADDING, config.padding ?? 0),
    ),
    timeout: Math.min(
      MAX_STATUS_LINE_TIMEOUT_MS,
      Math.max(1_000, config.timeout ?? DEFAULT_STATUS_LINE_TIMEOUT_MS),
    ),
    debounceMs: Math.max(
      MIN_STATUS_LINE_DEBOUNCE_MS,
      Math.min(
        MAX_STATUS_LINE_DEBOUNCE_MS,
        config.debounceMs ?? DEFAULT_STATUS_LINE_DEBOUNCE_MS,
      ),
    ),
    ...(refreshIntervalMs !== undefined && { refreshIntervalMs }),
    ...(config.disabled !== undefined && { disabled: config.disabled }),
  };
}

/**
 * Check whether the status line is disabled across settings levels.
 *
 * Precedence (mirrors `areHooksDisabled` in hooks/loader.ts):
 * 1. User `disabled: false` → ENABLED (explicit override)
 * 2. User `disabled: true`  → DISABLED
 * 3. Project or local-project `disabled: true` → DISABLED
 * 4. Default → ENABLED (if a config exists)
 */
export function isStatusLineDisabled(
  workingDirectory: string = process.cwd(),
): boolean {
  try {
    const userDisabled = settingsManager.getSettings().statusLine?.disabled;
    if (userDisabled === false) return false;
    if (userDisabled === true) return true;

    try {
      const projectDisabled =
        settingsManager.getProjectSettings(workingDirectory)?.statusLine
          ?.disabled;
      if (projectDisabled === true) return true;
    } catch {
      // Project settings not loaded
    }

    try {
      const localDisabled =
        settingsManager.getLocalProjectSettings(workingDirectory)?.statusLine
          ?.disabled;
      if (localDisabled === true) return true;
    } catch {
      // Local project settings not loaded
    }

    return false;
  } catch (error) {
    debugLog(
      "statusline",
      "isStatusLineDisabled: Failed to check disabled status",
      error,
    );
    return false;
  }
}

/**
 * Resolve effective status line config from all settings levels.
 * Returns null if no config is defined or the status line is disabled.
 *
 * Precedence: local project > project > global.
 */
export function resolveStatusLineConfig(
  workingDirectory: string = process.cwd(),
): NormalizedStatusLineConfig | null {
  try {
    if (isStatusLineDisabled(workingDirectory)) return null;

    // Local project settings (highest priority)
    try {
      const local =
        settingsManager.getLocalProjectSettings(workingDirectory)?.statusLine;
      if (local?.command) return normalizeStatusLineConfig(local);
    } catch {
      // Not loaded
    }

    // Project settings
    try {
      const project =
        settingsManager.getProjectSettings(workingDirectory)?.statusLine;
      if (project?.command) return normalizeStatusLineConfig(project);
    } catch {
      // Not loaded
    }

    // Global settings
    try {
      const global = settingsManager.getSettings().statusLine;
      if (global?.command) return normalizeStatusLineConfig(global);
    } catch {
      // Not initialized
    }

    return null;
  } catch (error) {
    debugLog(
      "statusline",
      "resolveStatusLineConfig: Failed to resolve config",
      error,
    );
    return null;
  }
}
