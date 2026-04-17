import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPendingChannelControlRequestsPath } from "./config";
import type { ChannelControlRequestEvent } from "./types";

type PendingControlRequestStore = {
  requests: ChannelControlRequestEvent[];
};

const EMPTY_STORE = (): PendingControlRequestStore => ({ requests: [] });

let store = EMPTY_STORE();
let storeLoaded = false;

let loadPendingControlRequestStoreOverride:
  | (() => PendingControlRequestStore | null)
  | null = null;
let savePendingControlRequestStoreOverride:
  | ((nextStore: PendingControlRequestStore) => void)
  | null = null;

function cloneEvent(
  event: ChannelControlRequestEvent,
): ChannelControlRequestEvent {
  return structuredClone(event);
}

function cloneStore(
  nextStore: PendingControlRequestStore,
): PendingControlRequestStore {
  return {
    requests: nextStore.requests.map((event) => cloneEvent(event)),
  };
}

function isChannelControlRequestEvent(
  value: unknown,
): value is ChannelControlRequestEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ChannelControlRequestEvent>;
  return (
    typeof candidate.requestId === "string" &&
    candidate.source !== undefined &&
    typeof candidate.source === "object" &&
    candidate.source !== null &&
    typeof candidate.source.channel === "string" &&
    typeof candidate.source.chatId === "string" &&
    typeof candidate.source.agentId === "string" &&
    typeof candidate.source.conversationId === "string" &&
    typeof candidate.toolName === "string" &&
    candidate.input !== null &&
    typeof candidate.input === "object"
  );
}

function ensureStoreLoaded(): void {
  if (storeLoaded) {
    return;
  }

  storeLoaded = true;

  if (loadPendingControlRequestStoreOverride) {
    const overridden = loadPendingControlRequestStoreOverride();
    store = overridden ? cloneStore(overridden) : EMPTY_STORE();
    return;
  }

  const storePath = getPendingChannelControlRequestsPath();
  if (!existsSync(storePath)) {
    store = EMPTY_STORE();
    return;
  }

  try {
    const text = readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(text) as Partial<PendingControlRequestStore>;
    store = {
      requests: Array.isArray(parsed.requests)
        ? parsed.requests.filter(isChannelControlRequestEvent).map(cloneEvent)
        : [],
    };
  } catch {
    store = EMPTY_STORE();
  }
}

function saveStore(): void {
  ensureStoreLoaded();

  const snapshot = cloneStore(store);
  if (savePendingControlRequestStoreOverride) {
    savePendingControlRequestStoreOverride(snapshot);
    return;
  }

  const storePath = getPendingChannelControlRequestsPath();
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

export function listPendingControlRequests(): ChannelControlRequestEvent[] {
  ensureStoreLoaded();
  return store.requests.map((event) => cloneEvent(event));
}

export function upsertPendingControlRequest(
  event: ChannelControlRequestEvent,
): ChannelControlRequestEvent {
  ensureStoreLoaded();

  const nextEvent = cloneEvent(event);
  const existingIndex = store.requests.findIndex(
    (candidate) => candidate.requestId === event.requestId,
  );
  if (existingIndex >= 0) {
    store.requests[existingIndex] = nextEvent;
  } else {
    store.requests.push(nextEvent);
  }

  saveStore();
  return cloneEvent(nextEvent);
}

export function removePendingControlRequest(requestId: string): boolean {
  ensureStoreLoaded();

  const nextRequests = store.requests.filter(
    (candidate) => candidate.requestId !== requestId,
  );
  if (nextRequests.length === store.requests.length) {
    return false;
  }

  store.requests = nextRequests;
  saveStore();
  return true;
}

export function clearPendingControlRequestStore(): void {
  store = EMPTY_STORE();
  storeLoaded = false;
}

export function __testOverrideLoadPendingControlRequestStore(
  fn: (() => PendingControlRequestStore | null) | null,
): void {
  loadPendingControlRequestStoreOverride = fn;
  storeLoaded = false;
}

export function __testOverrideSavePendingControlRequestStore(
  fn: ((nextStore: PendingControlRequestStore) => void) | null,
): void {
  savePendingControlRequestStoreOverride = fn;
}
