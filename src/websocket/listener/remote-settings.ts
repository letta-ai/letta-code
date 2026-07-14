/**
 * Persistent remote session settings stored in ~/.letta/remote-settings.json.
 *
 * Stores per-conversation CWD and permission mode so both survive letta server
 * restarts. Mirrors the in-memory Map keys used by cwd.ts and permissionMode.ts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isConfirmedUnusableDirectory } from "@/helpers/usable-directory";
import type { PermissionMode } from "@/permissions/mode";

/** Persisted permission mode state for a single conversation. */
export interface PersistedPermissionModeState {
  mode: PermissionMode;
}

export interface RemoteSettings {
  cwdMap?: Record<string, string>;
  permissionModeMap?: Record<string, PersistedPermissionModeState>;
}

// Module-level cache to avoid repeated disk reads and enable cheap merges.
let _cache: RemoteSettings | null = null;
let _settingsGeneration = 0;
let _settledGeneration = 0;
let _writeLoop: Promise<void> | null = null;

function getRemoteSettingsHome(): string {
  return process.env.HOME || homedir();
}

export function getRemoteSettingsPath(): string {
  return path.join(getRemoteSettingsHome(), ".letta", "remote-settings.json");
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

  let repairedCwdMap = false;

  // Validate cwdMap entries and durably remove stale paths. Persisting this
  // startup repair matters: otherwise recreating a deleted path can resurrect
  // the old conversation mapping on the next process restart.
  if (loaded.cwdMap) {
    const validCwdMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(loaded.cwdMap)) {
      if (typeof value === "string" && !isConfirmedUnusableDirectory(value)) {
        validCwdMap[key] = value;
      }
    }
    repairedCwdMap =
      Object.keys(validCwdMap).length !== Object.keys(loaded.cwdMap).length;
    loaded.cwdMap = validCwdMap;
  }

  // One-time migration: load legacy cwd-cache.json if cwdMap not present.
  if (!loaded.cwdMap) {
    loaded.cwdMap = loadLegacyCwdCache();
  }

  _cache = loaded;
  if (repairedCwdMap) {
    persistCurrentSettingsSync();
  }
  return _cache;
}

function persistRemoteSettingsSync(settings: RemoteSettings): void {
  try {
    const settingsPath = getRemoteSettingsPath();
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {
    // A read-time repair should not prevent listener startup.
  }
}

async function persistPendingRemoteSettings(): Promise<void> {
  while (_settledGeneration < _settingsGeneration) {
    const generation = _settingsGeneration;
    const serialized = JSON.stringify(_cache ?? {}, null, 2);
    const settingsPath = getRemoteSettingsPath();
    const tempPath = `${settingsPath}.${process.pid}.${generation}.tmp`;

    try {
      await mkdir(path.dirname(settingsPath), { recursive: true });
      await writeFile(tempPath, serialized);

      // A synchronous repair increments the generation before touching disk.
      // Since this check and rename are one JavaScript turn, the older staged
      // snapshot can only publish before the repair (which then wins) or be
      // discarded after it.
      if (generation === _settingsGeneration) {
        renameSync(tempPath, settingsPath);
      } else {
        await rm(tempPath, { force: true });
      }
    } catch {
      await rm(tempPath, { force: true }).catch(() => {});
    } finally {
      _settledGeneration = Math.max(_settledGeneration, generation);
    }
  }
}

function scheduleRemoteSettingsWrite(): void {
  if (_writeLoop) {
    return;
  }

  _writeLoop = persistPendingRemoteSettings().finally(() => {
    _writeLoop = null;
    if (_settledGeneration < _settingsGeneration) {
      scheduleRemoteSettingsWrite();
    }
  });
}

function persistCurrentSettingsSync(): void {
  const generation = ++_settingsGeneration;
  persistRemoteSettingsSync(_cache ?? {});
  _settledGeneration = Math.max(_settledGeneration, generation);
}

/**
 * Merge updates and queue the newest snapshot for serialized persistence.
 */
export function saveRemoteSettings(updates: Partial<RemoteSettings>): void {
  if (_cache === null) {
    loadRemoteSettings();
  }

  const nextSettings = {
    ..._cache,
    ...updates,
  };
  if (JSON.stringify(nextSettings) === JSON.stringify(_cache)) {
    return;
  }

  _cache = nextSettings;
  _settingsGeneration++;
  scheduleRemoteSettingsWrite();
}

/**
 * Persist a repair before returning and fence all older queued snapshots.
 */
export function saveRemoteSettingsSync(updates: Partial<RemoteSettings>): void {
  if (_cache === null) {
    loadRemoteSettings();
  }

  _cache = {
    ..._cache,
    ...updates,
  };
  persistCurrentSettingsSync();
}

export async function flushRemoteSettingsWrites(): Promise<void> {
  while (_writeLoop) {
    await _writeLoop;
  }
}

/**
 * Reset the in-memory cache (for testing).
 */
export function resetRemoteSettingsCache(): void {
  _cache = null;
  const generation = ++_settingsGeneration;
  _settledGeneration = Math.max(_settledGeneration, generation);
}

/**
 * @deprecated - only used for one-time migration from legacy cwd-cache.json
 */
function loadLegacyCwdCache(): Record<string, string> {
  try {
    const legacyPath = path.join(
      getRemoteSettingsHome(),
      ".letta",
      "cwd-cache.json",
    );
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
