/**
 * Persistent remote session settings stored in ~/.letta/remote-settings.json.
 *
 * Stores per-conversation CWD and permission mode so both survive letta server
 * restarts. Mirrors the in-memory Map keys used by cwd.ts and permissionMode.ts.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

type SettingsMapMutation<T> =
  | { kind: "set"; value: T }
  | { expected: T; kind: "delete" };

type SettingsMapPatch<T> = Record<string, SettingsMapMutation<T>>;

interface RemoteSettingsPatch {
  cwdMap?: SettingsMapPatch<string>;
  permissionModeMap?: SettingsMapPatch<PersistedPermissionModeState>;
}

interface PendingRemoteSettingsPatch {
  generation: number;
  patch: RemoteSettingsPatch;
}

// Module-level cache to avoid repeated disk reads and enable cheap merges.
let _cache: RemoteSettings | null = null;
let _settingsGeneration = 0;
let _settledGeneration = 0;
let _pendingPatches: PendingRemoteSettingsPatch[] = [];
let _writeLoop: Promise<void> | null = null;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;

const REMOTE_SETTINGS_RETRY_DELAY_MS = 250;
const REMOTE_SETTINGS_STALE_LOCK_MS = 30_000;
const REMOTE_SETTINGS_FLUSH_TIMEOUT_MS = 1_000;
const REMOTE_SETTINGS_FLUSH_RETRY_MIN_MS = 10;
const REMOTE_SETTINGS_FLUSH_RETRY_JITTER_MS = 30;
const REMOTE_SETTINGS_LOCK_OWNER = `${process.pid}-${randomUUID()}`;

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
  let originalCwdMap: Record<string, string> | undefined;

  // Validate cwdMap entries and durably remove stale paths. Persisting this
  // startup repair matters: otherwise recreating a deleted path can resurrect
  // the old conversation mapping on the next process restart.
  if (loaded.cwdMap) {
    originalCwdMap = { ...loaded.cwdMap };
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
    queueRemoteSettingsPatch(
      buildRemoteSettingsPatch(
        { cwdMap: originalCwdMap },
        { cwdMap: loaded.cwdMap },
      ),
    );
    persistCurrentSettingsSync();
  }
  return _cache;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function getRemoteSettingsLockPath(): string {
  return `${getRemoteSettingsPath()}.lock`;
}

function getRemoteSettingsLockOwnerPath(): string {
  return path.join(getRemoteSettingsLockPath(), "owner");
}

function isLockOwnerProcessAlive(owner: string): boolean {
  const separatorIndex = owner.indexOf("-");
  const ownerPid = Number(
    separatorIndex === -1 ? owner : owner.slice(0, separatorIndex),
  );
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    return false;
  }

  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

function isRemoteSettingsLockStaleSync(lockPath: string): boolean {
  try {
    if (
      isLockOwnerProcessAlive(
        readFileSync(path.join(lockPath, "owner"), "utf-8"),
      )
    ) {
      return false;
    }
  } catch {
    // An interrupted acquisition may not have written an owner file.
  }
  try {
    return (
      Date.now() - statSync(lockPath).mtimeMs > REMOTE_SETTINGS_STALE_LOCK_MS
    );
  } catch {
    return false;
  }
}

async function isRemoteSettingsLockStale(lockPath: string): Promise<boolean> {
  try {
    if (
      isLockOwnerProcessAlive(
        await readFile(path.join(lockPath, "owner"), "utf-8"),
      )
    ) {
      return false;
    }
  } catch {
    // An interrupted acquisition may not have written an owner file.
  }
  try {
    return (
      Date.now() - (await stat(lockPath)).mtimeMs >
      REMOTE_SETTINGS_STALE_LOCK_MS
    );
  } catch {
    return false;
  }
}

function tryAcquireRemoteSettingsLockSync(): boolean {
  const lockPath = getRemoteSettingsLockPath();
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(
          getRemoteSettingsLockOwnerPath(),
          REMOTE_SETTINGS_LOCK_OWNER,
        );
        return true;
      } catch {
        rmSync(lockPath, { recursive: true, force: true });
        return false;
      }
    } catch (error) {
      if (
        attempt > 0 ||
        !hasErrorCode(error, "EEXIST") ||
        !isRemoteSettingsLockStaleSync(lockPath)
      ) {
        return false;
      }
      const stalePath = `${lockPath}.${REMOTE_SETTINGS_LOCK_OWNER}.${Date.now()}.stale`;
      try {
        renameSync(lockPath, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

async function tryAcquireRemoteSettingsLock(): Promise<boolean> {
  const lockPath = getRemoteSettingsLockPath();
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
  } catch {
    return false;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          getRemoteSettingsLockOwnerPath(),
          REMOTE_SETTINGS_LOCK_OWNER,
        );
        return true;
      } catch {
        await rm(lockPath, { recursive: true, force: true });
        return false;
      }
    } catch (error) {
      if (
        attempt > 0 ||
        !hasErrorCode(error, "EEXIST") ||
        !(await isRemoteSettingsLockStale(lockPath))
      ) {
        return false;
      }
      const stalePath = `${lockPath}.${REMOTE_SETTINGS_LOCK_OWNER}.${Date.now()}.stale`;
      try {
        await rename(lockPath, stalePath);
        await rm(stalePath, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseRemoteSettingsLockSync(): void {
  try {
    if (
      readFileSync(getRemoteSettingsLockOwnerPath(), "utf-8") !==
      REMOTE_SETTINGS_LOCK_OWNER
    ) {
      return;
    }
    rmSync(getRemoteSettingsLockPath(), { recursive: true, force: true });
  } catch {
    // A later writer can recover the lock after its stale timeout.
  }
}

async function releaseRemoteSettingsLock(): Promise<void> {
  try {
    if (
      (await readFile(getRemoteSettingsLockOwnerPath(), "utf-8")) !==
      REMOTE_SETTINGS_LOCK_OWNER
    ) {
      return;
    }
  } catch {
    return;
  }
  await rm(getRemoteSettingsLockPath(), { recursive: true, force: true }).catch(
    () => {},
  );
}

function readCurrentRemoteSettingsSync(): RemoteSettings | null {
  try {
    return JSON.parse(
      readFileSync(getRemoteSettingsPath(), "utf-8"),
    ) as RemoteSettings;
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? {} : null;
  }
}

async function readCurrentRemoteSettings(): Promise<RemoteSettings | null> {
  try {
    return JSON.parse(
      await readFile(getRemoteSettingsPath(), "utf-8"),
    ) as RemoteSettings;
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? {} : null;
  }
}

function createSettingsMapPatch<T>(
  previous: Record<string, T> | undefined,
  next: Record<string, T>,
  valuesEqual: (left: T, right: T) => boolean,
): SettingsMapPatch<T> | undefined {
  const patch: SettingsMapPatch<T> = {};
  const previousMap = previous ?? {};
  const keys = new Set([...Object.keys(previousMap), ...Object.keys(next)]);

  for (const key of keys) {
    if (!Object.hasOwn(next, key)) {
      patch[key] = {
        expected: previousMap[key] as T,
        kind: "delete",
      };
    } else if (
      !Object.hasOwn(previousMap, key) ||
      !valuesEqual(previousMap[key] as T, next[key] as T)
    ) {
      patch[key] = { kind: "set", value: next[key] as T };
    }
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function buildRemoteSettingsPatch(
  previous: RemoteSettings,
  updates: Partial<RemoteSettings>,
): RemoteSettingsPatch {
  const patch: RemoteSettingsPatch = {};
  if (updates.cwdMap !== undefined) {
    patch.cwdMap = createSettingsMapPatch(
      previous.cwdMap,
      updates.cwdMap,
      (left, right) => left === right,
    );
  }
  if (updates.permissionModeMap !== undefined) {
    patch.permissionModeMap = createSettingsMapPatch(
      previous.permissionModeMap,
      updates.permissionModeMap,
      (left, right) => left.mode === right.mode,
    );
  }
  return patch;
}

function isRemoteSettingsPatchEmpty(patch: RemoteSettingsPatch): boolean {
  return patch.cwdMap === undefined && patch.permissionModeMap === undefined;
}

function queueRemoteSettingsPatch(
  patch: RemoteSettingsPatch,
  forceGeneration = false,
): number | null {
  if (isRemoteSettingsPatchEmpty(patch) && !forceGeneration) {
    return null;
  }

  const generation = ++_settingsGeneration;
  if (!isRemoteSettingsPatchEmpty(patch)) {
    _pendingPatches.push({ generation, patch });
  }
  return generation;
}

function applySettingsMapPatch<T>(
  current: Record<string, T> | undefined,
  patch: SettingsMapPatch<T>,
  valuesEqual: (left: T, right: T) => boolean,
): Record<string, T> {
  const result = { ...current };
  for (const [key, mutation] of Object.entries(patch)) {
    if (mutation.kind === "delete") {
      const currentValue = result[key];
      if (
        currentValue !== undefined &&
        valuesEqual(currentValue, mutation.expected)
      ) {
        delete result[key];
      }
    } else {
      result[key] = mutation.value;
    }
  }
  return result;
}

function applyPendingRemoteSettingsPatches(
  settings: RemoteSettings,
  generation: number,
): RemoteSettings {
  const result = { ...settings };
  for (const pending of _pendingPatches) {
    if (pending.generation > generation) continue;
    if (pending.patch.cwdMap) {
      result.cwdMap = applySettingsMapPatch(
        result.cwdMap,
        pending.patch.cwdMap,
        (left, right) => left === right,
      );
    }
    if (pending.patch.permissionModeMap) {
      result.permissionModeMap = applySettingsMapPatch(
        result.permissionModeMap,
        pending.patch.permissionModeMap,
        (left, right) => left.mode === right.mode,
      );
    }
  }
  return result;
}

function settleRemoteSettingsGeneration(generation: number): void {
  _pendingPatches = _pendingPatches.filter(
    (pending) => pending.generation > generation,
  );
  _settledGeneration = Math.max(_settledGeneration, generation);
}

function hasPendingPatchThrough(generation: number): boolean {
  return _pendingPatches.some((pending) => pending.generation <= generation);
}

function persistRemoteSettingsSync(generation: number): boolean {
  if (!hasPendingPatchThrough(generation)) {
    settleRemoteSettingsGeneration(generation);
    return true;
  }
  if (!tryAcquireRemoteSettingsLockSync()) {
    return false;
  }

  const settingsPath = getRemoteSettingsPath();
  const tempPath = `${settingsPath}.${process.pid}.${generation}.sync.tmp`;
  try {
    const current = readCurrentRemoteSettingsSync();
    if (current === null) return false;
    const settings = applyPendingRemoteSettingsPatches(current, generation);
    writeFileSync(tempPath, JSON.stringify(settings, null, 2));
    renameSync(tempPath, settingsPath);
    settleRemoteSettingsGeneration(generation);
    return true;
  } catch {
    // Callers keep the generation dirty so it can be retried.
    return false;
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; a later retry overwrites the same temp path.
    }
    releaseRemoteSettingsLockSync();
  }
}

async function persistPendingRemoteSettings(): Promise<void> {
  while (_settledGeneration < _settingsGeneration) {
    const generation = _settingsGeneration;
    if (!hasPendingPatchThrough(generation)) {
      settleRemoteSettingsGeneration(generation);
      continue;
    }
    if (!(await tryAcquireRemoteSettingsLock())) {
      return;
    }

    const settingsPath = getRemoteSettingsPath();
    const tempPath = `${settingsPath}.${process.pid}.${generation}.tmp`;
    let published = false;

    try {
      const current = await readCurrentRemoteSettings();
      if (current === null) return;
      const settings = applyPendingRemoteSettingsPatches(current, generation);
      await writeFile(tempPath, JSON.stringify(settings, null, 2));

      // A synchronous repair increments the generation before touching disk.
      // Since this check and rename are one JavaScript turn, the older staged
      // snapshot can only publish before the repair (which then wins) or be
      // discarded after it.
      if (generation === _settingsGeneration) {
        renameSync(tempPath, settingsPath);
        published = true;
        settleRemoteSettingsGeneration(generation);
      }
    } catch {
      return;
    } finally {
      if (!published) {
        await rm(tempPath, { force: true }).catch(() => {});
      }
      await releaseRemoteSettingsLock();
    }
  }
}

function clearRemoteSettingsRetry(): void {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
}

function scheduleRemoteSettingsRetry(): void {
  if (_retryTimer || _settledGeneration >= _settingsGeneration) {
    return;
  }

  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    scheduleRemoteSettingsWrite();
  }, REMOTE_SETTINGS_RETRY_DELAY_MS);
  _retryTimer.unref();
}

function scheduleRemoteSettingsWrite(): void {
  if (_writeLoop) {
    return;
  }

  clearRemoteSettingsRetry();
  _writeLoop = persistPendingRemoteSettings().finally(() => {
    _writeLoop = null;
    if (_settledGeneration < _settingsGeneration) {
      scheduleRemoteSettingsRetry();
    }
  });
}

function persistCurrentSettingsSync(): void {
  if (!persistRemoteSettingsSync(_settingsGeneration)) {
    scheduleRemoteSettingsRetry();
  }
}

/**
 * Merge updates and queue the newest snapshot for serialized persistence.
 */
export function saveRemoteSettings(updates: Partial<RemoteSettings>): void {
  if (_cache === null) {
    loadRemoteSettings();
  }

  const previous = _cache ?? {};
  const nextSettings = {
    ...previous,
    ...updates,
  };
  const generation = queueRemoteSettingsPatch(
    buildRemoteSettingsPatch(previous, updates),
  );
  _cache = nextSettings;
  if (generation === null) {
    if (_settledGeneration < _settingsGeneration) {
      scheduleRemoteSettingsWrite();
    }
    return;
  }

  scheduleRemoteSettingsWrite();
}

/**
 * Attempt immediate repair persistence and fence older queued snapshots.
 * Transient failures stay queued for the asynchronous retry loop.
 */
export function saveRemoteSettingsSync(updates: Partial<RemoteSettings>): void {
  if (_cache === null) {
    loadRemoteSettings();
  }

  const previous = _cache ?? {};
  _cache = {
    ...previous,
    ...updates,
  };
  queueRemoteSettingsPatch(buildRemoteSettingsPatch(previous, updates), true);
  persistCurrentSettingsSync();
}

export async function flushRemoteSettingsWrites(): Promise<boolean> {
  clearRemoteSettingsRetry();
  while (_writeLoop) {
    await _writeLoop;
    clearRemoteSettingsRetry();
  }

  if (_settledGeneration >= _settingsGeneration) {
    return true;
  }

  const deadline = Date.now() + REMOTE_SETTINGS_FLUSH_TIMEOUT_MS;
  while (true) {
    if (persistRemoteSettingsSync(_settingsGeneration)) {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const retryDelayMs = Math.min(
      remainingMs,
      REMOTE_SETTINGS_FLUSH_RETRY_MIN_MS +
        Math.floor(Math.random() * REMOTE_SETTINGS_FLUSH_RETRY_JITTER_MS),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }

  scheduleRemoteSettingsRetry();
  return false;
}

/**
 * Reset the in-memory cache (for testing).
 */
export function resetRemoteSettingsCache(): void {
  clearRemoteSettingsRetry();
  _cache = null;
  const generation = ++_settingsGeneration;
  _pendingPatches = [];
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
