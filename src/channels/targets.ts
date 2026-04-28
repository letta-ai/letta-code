import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import { getChannelDir, getChannelTargetsPath } from "./config";
import type { ChannelBindableTarget } from "./types";

interface ChannelTargetStore {
  targets: ChannelBindableTarget[];
}

const stores = new Map<string, ChannelTargetStore>();
let loadTargetStoreOverride: ((channelId: string) => void) | null = null;
let saveTargetStoreOverride:
  | ((channelId: string, store: ChannelTargetStore) => void)
  | null = null;

function getStore(channelId: string): ChannelTargetStore {
  let store = stores.get(channelId);
  if (!store) {
    store = { targets: [] };
    stores.set(channelId, store);
  }
  return store;
}

export function loadTargetStore(channelId: string): void {
  if (loadTargetStoreOverride) {
    loadTargetStoreOverride(channelId);
    return;
  }

  const path = getChannelTargetsPath(channelId);
  if (!existsSync(path)) {
    return;
  }

  try {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as Partial<ChannelTargetStore>;
    stores.set(channelId, {
      targets: parsed.targets ?? [],
    });
  } catch {
    // Corrupted target caches should not block startup.
  }
}

function saveTargetStore(channelId: string): void {
  if (saveTargetStoreOverride) {
    saveTargetStoreOverride(channelId, getStore(channelId));
    return;
  }

  const dir = getChannelDir(channelId);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    getChannelTargetsPath(channelId),
    `${JSON.stringify(getStore(channelId), null, 2)}\n`,
    "utf-8",
  );
}

export function listChannelTargets(
  channelId: string,
  accountId?: string,
): ChannelBindableTarget[] {
  const normalizedAccountId =
    accountId === undefined ? undefined : normalizeAccountId(accountId);
  return getStore(channelId).targets.filter(
    (target) =>
      normalizedAccountId === undefined ||
      normalizeAccountId(target.accountId) === normalizedAccountId,
  );
}

export function getChannelTarget(
  channelId: string,
  targetId: string,
  accountId?: string,
): ChannelBindableTarget | null {
  const normalizedAccountId = normalizeAccountId(accountId);
  return (
    getStore(channelId).targets.find(
      (target) =>
        target.targetId === targetId &&
        normalizeAccountId(target.accountId) === normalizedAccountId,
    ) ?? null
  );
}

export function upsertChannelTarget(
  channelId: string,
  target: ChannelBindableTarget,
): ChannelBindableTarget {
  const store = getStore(channelId);
  const normalizedAccountId = normalizeAccountId(target.accountId);
  const existingIndex = store.targets.findIndex(
    (candidate) =>
      candidate.targetId === target.targetId &&
      normalizeAccountId(candidate.accountId) === normalizedAccountId,
  );

  if (existingIndex >= 0) {
    const existing = store.targets[existingIndex];
    if (!existing) {
      throw new Error(
        `Target index ${existingIndex} missing for ${target.targetId}`,
      );
    }
    const merged: ChannelBindableTarget = {
      ...existing,
      ...target,
      accountId: normalizedAccountId,
      discoveredAt: existing.discoveredAt,
      lastSeenAt: target.lastSeenAt,
    };
    store.targets[existingIndex] = merged;
    saveTargetStore(channelId);
    return merged;
  }

  store.targets.push({
    ...target,
    accountId: normalizedAccountId,
  });
  saveTargetStore(channelId);
  return {
    ...target,
    accountId: normalizedAccountId,
  };
}

export function removeChannelTarget(
  channelId: string,
  targetId: string,
  accountId?: string,
): boolean {
  const store = getStore(channelId);
  const normalizedAccountId = normalizeAccountId(accountId);
  const nextTargets = store.targets.filter(
    (target) =>
      !(
        target.targetId === targetId &&
        normalizeAccountId(target.accountId) === normalizedAccountId
      ),
  );
  if (nextTargets.length === store.targets.length) {
    return false;
  }
  store.targets = nextTargets;
  saveTargetStore(channelId);
  return true;
}

export function removeChannelTargetsForAccount(
  channelId: string,
  accountId: string,
): number {
  const store = getStore(channelId);
  const normalizedAccountId = normalizeAccountId(accountId);
  const nextTargets = store.targets.filter(
    (target) => normalizeAccountId(target.accountId) !== normalizedAccountId,
  );
  const removed = store.targets.length - nextTargets.length;
  if (removed === 0) {
    return 0;
  }
  store.targets = nextTargets;
  saveTargetStore(channelId);
  return removed;
}

export function clearTargetStores(): void {
  stores.clear();
}

/** @internal Test-only: override loadTargetStore behavior. Pass null to restore. */
export function __testOverrideLoadTargetStore(
  fn: ((channelId: string) => void) | null,
): void {
  loadTargetStoreOverride = fn;
}

/** @internal Test-only: override saveTargetStore behavior. Pass null to restore. */
export function __testOverrideSaveTargetStore(
  fn: ((channelId: string, store: ChannelTargetStore) => void) | null,
): void {
  saveTargetStoreOverride = fn;
}
function normalizeAccountId(accountId?: string): string {
  return accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
}
