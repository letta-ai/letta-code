/**
 * Persistent remote session settings stored in ~/.letta/remote-settings.json.
 *
 * Stores per-conversation CWD and permission mode so both survive letta server
 * restarts. Mirrors the in-memory Map keys used by cwd.ts and permissionMode.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { PermissionMode } from "../../permissions/mode";

/**
 * Persisted permission mode state for a single conversation.
 * planFilePath is intentionally excluded — it's ephemeral and tied to a
 * specific process run; it should not be restored across restarts.
 */
export interface PersistedPermissionModeState {
  mode: PermissionMode;
  modeBeforePlan: PermissionMode | null;
}

export interface RemoteSettings {
  cwdMap?: Record<string, string>;
  permissionModeMap?: Record<string, PersistedPermissionModeState>;
}

// Module-level cache to avoid repeated disk reads and enable cheap merges.
let _cache: RemoteSettings | null = null;

export function getRemoteSettingsPath(): string {
  return path.join(homedir(), ".letta", "remote-settings.json");
}

/**
 * Load remote settings synchronously from disk (called once at startup).
 * Populates the in-memory cache. Returns {} on any read/parse error.
 *
 * Applies a one-time migration: if cwdMap is absent, tries to load
 * the legacy ~/.letta/cwd-cache.json.
 */
export function loadRemoteSettings(): RemoteSettings {
  if (_cache !== null) {
    return _cache;
  }

  let loaded: RemoteSettings = {};

  try {
    const settingsPath = getRemoteSettingsPath();
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw) as RemoteSettings;
      loaded = parsed;
    }
  } catch {
    // Silently fall back to empty settings.
  }

  // Validate cwdMap entries — filter out stale paths.
  if (loaded.cwdMap) {
    const validCwdMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(loaded.cwdMap)) {
      if (typeof value === "string" && existsSync(value)) {
        validCwdMap[key] = value;
      }
    }
    loaded.cwdMap = validCwdMap;
  }

  // One-time migration: load legacy cwd-cache.json if cwdMap not present.
  if (!loaded.cwdMap) {
    loaded.cwdMap = loadLegacyCwdCache();
  }

  _cache = loaded;
  return _cache;
}

/**
 * Merge updates into the in-memory cache and persist asynchronously.
 * Silently swallows write failures.
 */
export function saveRemoteSettings(updates: Partial<RemoteSettings>): void {
  if (_cache === null) {
    loadRemoteSettings();
  }

  _cache = {
    ..._cache,
    ...updates,
  };

  const snapshot = _cache;
  const settingsPath = getRemoteSettingsPath();
  void mkdir(path.dirname(settingsPath), { recursive: true })
    .then(() => writeFile(settingsPath, JSON.stringify(snapshot, null, 2)))
    .catch(() => {
      // Silently ignore write failures.
    });
}

/**
 * Reset the in-memory cache (for testing).
 */
export function resetRemoteSettingsCache(): void {
  _cache = null;
}

/**
 * @deprecated - only used for one-time migration from legacy cwd-cache.json
 */
function loadLegacyCwdCache(): Record<string, string> {
  try {
    const legacyPath = path.join(homedir(), ".letta", "cwd-cache.json");
    if (!existsSync(legacyPath)) return {};
    const raw = readFileSync(legacyPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && existsSync(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
