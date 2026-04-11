import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getChannelDir, getChannelTargetsPath } from "./config";
import type { ChannelBindableTarget } from "./types";

interface ChannelTargetStore {
  targets: ChannelBindableTarget[];
}

const stores = new Map<string, ChannelTargetStore>();

function getStore(channelId: string): ChannelTargetStore {
  let store = stores.get(channelId);
  if (!store) {
    store = { targets: [] };
    stores.set(channelId, store);
  }
  return store;
}

export function loadTargetStore(channelId: string): void {
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
  const dir = getChannelDir(channelId);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    getChannelTargetsPath(channelId),
    `${JSON.stringify(getStore(channelId), null, 2)}\n`,
    "utf-8",
  );
}

export function listChannelTargets(channelId: string): ChannelBindableTarget[] {
  return [...getStore(channelId).targets];
}

export function getChannelTarget(
  channelId: string,
  targetId: string,
): ChannelBindableTarget | null {
  return (
    getStore(channelId).targets.find(
      (target) => target.targetId === targetId,
    ) ?? null
  );
}

export function upsertChannelTarget(
  channelId: string,
  target: ChannelBindableTarget,
): ChannelBindableTarget {
  const store = getStore(channelId);
  const existingIndex = store.targets.findIndex(
    (candidate) => candidate.targetId === target.targetId,
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
      discoveredAt: existing.discoveredAt,
      lastSeenAt: target.lastSeenAt,
    };
    store.targets[existingIndex] = merged;
    saveTargetStore(channelId);
    return merged;
  }

  store.targets.push(target);
  saveTargetStore(channelId);
  return target;
}

export function removeChannelTarget(
  channelId: string,
  targetId: string,
): boolean {
  const store = getStore(channelId);
  const nextTargets = store.targets.filter(
    (target) => target.targetId !== targetId,
  );
  if (nextTargets.length === store.targets.length) {
    return false;
  }
  store.targets = nextTargets;
  saveTargetStore(channelId);
  return true;
}

export function clearTargetStores(): void {
  stores.clear();
}
