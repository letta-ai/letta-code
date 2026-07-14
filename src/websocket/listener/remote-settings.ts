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
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isConfirmedUnusableDirectory } from "@/helpers/usable-directory";
import type { PermissionMode } from "@/permissions/mode";
import {
  flushAbandonedRemoteSettingsLock,
  releaseRemoteSettingsLock,
  releaseRemoteSettingsLockSync,
  tryAcquireRemoteSettingsLock,
  tryAcquireRemoteSettingsLockSync,
} from "./remote-settings-lock";

/** Persisted permission mode state for a single conversation. */
export interface PersistedPermissionModeState {
  mode: PermissionMode;
}

export interface RemoteSettings {
  cwdMap?: Record<string, string>;
  cwdRepairJournalIds?: string[];
  permissionModeMap?: Record<string, PersistedPermissionModeState>;
}

interface CwdRepairJournal {
  cwdDeletes: Record<string, string>;
  id: string;
  path: string;
}

interface CurrentRemoteSettings {
  repairJournals: CwdRepairJournal[];
  settings: RemoteSettings;
}

type SettingsMapMutation<T> =
  | { kind: "set"; value: T }
  | { expected: T; kind: "delete" };

type SettingsMapPatch<T> = Record<string, SettingsMapMutation<T>>;

interface RemoteSettingsPatch {
  cwdMap?: SettingsMapPatch<string>;
  initializeCwdMap?: Record<string, string>;
  permissionModeMap?: SettingsMapPatch<PersistedPermissionModeState>;
}

interface PendingRemoteSettingsPatch {
  generation: number;
  patch: RemoteSettingsPatch;
  repairJournalId?: string;
}

// Module-level cache to avoid repeated disk reads and enable cheap merges.
let _cache: RemoteSettings | null = null;
let _settingsGeneration = 0;
let _settledGeneration = 0;
let _pendingPatches: PendingRemoteSettingsPatch[] = [];
let _writeLoop: Promise<void> | null = null;
let _retryTimer: ReturnType<typeof setTimeout> | null = null;

const REMOTE_SETTINGS_RETRY_DELAY_MS = 250;
const REMOTE_SETTINGS_FLUSH_TIMEOUT_MS = 1_000;
const REMOTE_SETTINGS_FLUSH_RETRY_MIN_MS = 10;
const REMOTE_SETTINGS_FLUSH_RETRY_JITTER_MS = 30;

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
  let migratedLegacyCwdMap = false;
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
    migratedLegacyCwdMap = true;
  }

  const startupRepairJournals = readCwdRepairJournals(getRemoteSettingsPath());
  loaded = applyCwdRepairJournals(loaded, startupRepairJournals);

  _cache = loaded;
  if (repairedCwdMap) {
    const repairPatch = buildRemoteSettingsPatch(
      { cwdMap: originalCwdMap },
      { cwdMap: loaded.cwdMap },
    );
    const repairJournalId = writeCwdRepairJournal(
      getRemoteSettingsPath(),
      repairPatch,
    );
    queueRemoteSettingsPatch(repairPatch, false, repairJournalId ?? undefined);
    persistCurrentSettingsSync();
  } else if (migratedLegacyCwdMap) {
    queueRemoteSettingsPatch({ initializeCwdMap: loaded.cwdMap });
    persistCurrentSettingsSync();
  } else if (startupRepairJournals.length > 0) {
    queueRemoteSettingsPatch({}, true);
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

function getRemoteSettingsLockPath(settingsPath: string): string {
  return `${settingsPath}.lock`;
}

function getCwdRepairJournalPrefix(settingsPath: string): string {
  return `${path.basename(settingsPath)}.cwd-repair.`;
}

function readCwdRepairJournals(settingsPath: string): CwdRepairJournal[] {
  const directory = path.dirname(settingsPath);
  const prefix = getCwdRepairJournalPrefix(settingsPath);
  let names: string[];
  try {
    names = readdirSync(directory).filter(
      (name) =>
        name.startsWith(prefix) &&
        (name.endsWith(".json") || name.endsWith(".tmp")),
    );
  } catch {
    return [];
  }

  const journals: CwdRepairJournal[] = [];
  for (const name of names) {
    const journalPath = path.join(directory, name);
    try {
      const parsed = JSON.parse(readFileSync(journalPath, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        !record.cwdDeletes ||
        typeof record.cwdDeletes !== "object" ||
        Array.isArray(record.cwdDeletes)
      ) {
        continue;
      }
      const cwdDeletes = Object.fromEntries(
        Object.entries(record.cwdDeletes).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      if (Object.keys(cwdDeletes).length === 0) continue;
      journals.push({ cwdDeletes, id: record.id, path: journalPath });
    } catch {
      // Preserve unreadable journals for a later retry or manual diagnosis.
    }
  }
  return journals;
}

function applyCwdRepairJournals(
  settings: RemoteSettings,
  journals: CwdRepairJournal[],
): RemoteSettings {
  if (journals.length === 0) return settings;

  const appliedIds = new Set(
    Array.isArray(settings.cwdRepairJournalIds)
      ? settings.cwdRepairJournalIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const cwdMap = { ...settings.cwdMap };
  for (const journal of journals) {
    if (appliedIds.has(journal.id)) continue;
    for (const [key, expected] of Object.entries(journal.cwdDeletes)) {
      if (cwdMap[key] === expected) delete cwdMap[key];
    }
    appliedIds.add(journal.id);
  }

  return {
    ...settings,
    cwdMap,
    cwdRepairJournalIds: [...appliedIds],
  };
}

function writeCwdRepairJournal(
  settingsPath: string,
  patch: RemoteSettingsPatch,
): string | null {
  if (!patch.cwdMap) return null;
  const cwdDeletes = Object.fromEntries(
    Object.entries(patch.cwdMap).flatMap(([key, mutation]) =>
      mutation.kind === "delete" ? [[key, mutation.expected]] : [],
    ),
  );
  if (Object.keys(cwdDeletes).length === 0) return null;

  const id = randomUUID();
  const journalPath = path.join(
    path.dirname(settingsPath),
    `${getCwdRepairJournalPrefix(settingsPath)}${id}.json`,
  );
  const tempPath = `${journalPath}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(tempPath, JSON.stringify({ cwdDeletes, id }, null, 2));
    renameSync(tempPath, journalPath);
    return id;
  } catch {
    if (process.env.LETTA_DEBUG) {
      console.warn("[Remote Settings] Unable to persist cwd repair journal");
    }
    return null;
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; the published journal never uses the temp path.
    }
  }
}

function cleanupCwdRepairJournals(journals: CwdRepairJournal[]): void {
  for (const journal of journals) {
    try {
      rmSync(journal.path, { force: true });
    } catch {
      // The applied journal ID fences a replay if cleanup fails or we crash.
    }
  }
}

function readCurrentRemoteSettingsSync(
  settingsPath: string,
): CurrentRemoteSettings | null {
  try {
    const settings = JSON.parse(
      readFileSync(settingsPath, "utf-8"),
    ) as RemoteSettings;
    const repairJournals = readCwdRepairJournals(settingsPath);
    return {
      repairJournals,
      settings: applyCwdRepairJournals(settings, repairJournals),
    };
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) return null;
    const repairJournals = readCwdRepairJournals(settingsPath);
    return {
      repairJournals,
      settings: applyCwdRepairJournals({}, repairJournals),
    };
  }
}

async function readCurrentRemoteSettings(
  settingsPath: string,
): Promise<CurrentRemoteSettings | null> {
  try {
    const settings = JSON.parse(
      await readFile(settingsPath, "utf-8"),
    ) as RemoteSettings;
    const repairJournals = readCwdRepairJournals(settingsPath);
    return {
      repairJournals,
      settings: applyCwdRepairJournals(settings, repairJournals),
    };
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) return null;
    const repairJournals = readCwdRepairJournals(settingsPath);
    return {
      repairJournals,
      settings: applyCwdRepairJournals({}, repairJournals),
    };
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
  return (
    patch.cwdMap === undefined &&
    patch.initializeCwdMap === undefined &&
    patch.permissionModeMap === undefined
  );
}

function queueRemoteSettingsPatch(
  patch: RemoteSettingsPatch,
  forceGeneration = false,
  repairJournalId?: string,
): number | null {
  if (isRemoteSettingsPatchEmpty(patch) && !forceGeneration) {
    return null;
  }

  const generation = ++_settingsGeneration;
  if (!isRemoteSettingsPatchEmpty(patch)) {
    _pendingPatches.push({ generation, patch, repairJournalId });
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
    if (
      pending.patch.initializeCwdMap !== undefined &&
      result.cwdMap === undefined
    ) {
      result.cwdMap = { ...pending.patch.initializeCwdMap };
    }
    if (pending.patch.cwdMap) {
      const repairAlreadyApplied =
        pending.repairJournalId !== undefined &&
        Array.isArray(result.cwdRepairJournalIds) &&
        result.cwdRepairJournalIds.includes(pending.repairJournalId);
      const cwdMapPatch = repairAlreadyApplied
        ? Object.fromEntries(
            Object.entries(pending.patch.cwdMap).filter(
              ([, mutation]) => mutation.kind === "set",
            ),
          )
        : pending.patch.cwdMap;
      if (Object.keys(cwdMapPatch).length > 0) {
        result.cwdMap = applySettingsMapPatch(
          result.cwdMap,
          cwdMapPatch,
          (left, right) => left === right,
        );
      }
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
  const settingsPath = getRemoteSettingsPath();
  if (
    !hasPendingPatchThrough(generation) &&
    readCwdRepairJournals(settingsPath).length === 0
  ) {
    settleRemoteSettingsGeneration(generation);
    return true;
  }
  const lock = tryAcquireRemoteSettingsLockSync(
    getRemoteSettingsLockPath(settingsPath),
  );
  if (!lock) return false;

  const tempPath = `${settingsPath}.${process.pid}.${generation}.sync.tmp`;
  try {
    const current = readCurrentRemoteSettingsSync(settingsPath);
    if (current === null) return false;
    const settings = applyPendingRemoteSettingsPatches(
      current.settings,
      generation,
    );
    writeFileSync(tempPath, JSON.stringify(settings, null, 2));
    renameSync(tempPath, settingsPath);
    settleRemoteSettingsGeneration(generation);
    cleanupCwdRepairJournals(current.repairJournals);
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
    releaseRemoteSettingsLockSync(lock);
  }
}

async function persistPendingRemoteSettings(): Promise<void> {
  while (_settledGeneration < _settingsGeneration) {
    const generation = _settingsGeneration;
    const settingsPath = getRemoteSettingsPath();
    if (
      !hasPendingPatchThrough(generation) &&
      readCwdRepairJournals(settingsPath).length === 0
    ) {
      settleRemoteSettingsGeneration(generation);
      continue;
    }
    const lock = await tryAcquireRemoteSettingsLock(
      getRemoteSettingsLockPath(settingsPath),
    );
    if (!lock) return;

    const tempPath = `${settingsPath}.${process.pid}.${generation}.tmp`;
    let published = false;

    try {
      const current = await readCurrentRemoteSettings(settingsPath);
      if (current === null) return;
      const settings = applyPendingRemoteSettingsPatches(
        current.settings,
        generation,
      );
      await writeFile(tempPath, JSON.stringify(settings, null, 2));

      // A synchronous repair increments the generation before touching disk.
      // Since this check and rename are one JavaScript turn, the older staged
      // snapshot can only publish before the repair (which then wins) or be
      // discarded after it.
      if (generation === _settingsGeneration) {
        renameSync(tempPath, settingsPath);
        published = true;
        settleRemoteSettingsGeneration(generation);
        cleanupCwdRepairJournals(current.repairJournals);
      }
    } catch {
      return;
    } finally {
      if (!published) {
        await rm(tempPath, { force: true }).catch(() => {});
      }
      await releaseRemoteSettingsLock(lock);
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
 * Queue an explicit cwd assignment even when it matches this process's cache.
 * Another listener may have published a conditional repair journal after our
 * cache was loaded; the unconditional set records that this user assignment is
 * newer than that repair when both are merged under the settings lock.
 */
export function saveRemoteSettingsCwdAssignment(
  scopeKey: string,
  workingDirectory: string,
): void {
  if (_cache === null) {
    loadRemoteSettings();
  }

  const previous = _cache ?? {};
  _cache = {
    ...previous,
    cwdMap: {
      ...previous.cwdMap,
      [scopeKey]: workingDirectory,
    },
  };
  queueRemoteSettingsPatch({
    cwdMap: {
      [scopeKey]: { kind: "set", value: workingDirectory },
    },
  });
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
  const patch = buildRemoteSettingsPatch(previous, updates);
  const repairJournalId = writeCwdRepairJournal(getRemoteSettingsPath(), patch);
  _cache = {
    ...previous,
    ...updates,
  };
  queueRemoteSettingsPatch(patch, true, repairJournalId ?? undefined);
  persistCurrentSettingsSync();
}

export async function flushRemoteSettingsWrites(): Promise<boolean> {
  const deadline = Date.now() + REMOTE_SETTINGS_FLUSH_TIMEOUT_MS;
  clearRemoteSettingsRetry();
  while (_writeLoop) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;

    const writeLoop = _writeLoop;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      writeLoop.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!completed) return false;
    clearRemoteSettingsRetry();
  }

  if (_settledGeneration >= _settingsGeneration) {
    return flushAbandonedRemoteSettingsLock(deadline);
  }

  while (true) {
    if (persistRemoteSettingsSync(_settingsGeneration)) {
      return flushAbandonedRemoteSettingsLock(deadline);
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
      if (typeof value === "string" && !isConfirmedUnusableDirectory(value)) {
        result[key] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}
