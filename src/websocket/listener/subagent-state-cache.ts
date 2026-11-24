import type { SubagentSnapshot } from "@/types/protocol_v2";

type SubagentStateScope = {
  agent_id?: string | null;
  conversation_id?: string | null;
};

const EMPTY_SNAPSHOT_JSON = "[]";

const lastSubagentSnapshotByOwner = new WeakMap<object, Map<string, string>>();

export function clearSubagentSnapshotCache(owner: object): void {
  lastSubagentSnapshotByOwner.delete(owner);
}

export function shouldEmitSubagentSnapshot(
  owner: object,
  scope: SubagentStateScope | null,
  snapshot: SubagentSnapshot[],
  options?: { onlyIfChanged?: boolean },
): boolean {
  const snapshotJson = JSON.stringify(snapshot);
  const cacheKey = `${scope?.agent_id ?? ""}:${scope?.conversation_id ?? ""}`;
  let scopeCache = lastSubagentSnapshotByOwner.get(owner);
  if (!scopeCache) {
    scopeCache = new Map();
    lastSubagentSnapshotByOwner.set(owner, scopeCache);
  }
  const previousJson = scopeCache.get(cacheKey) ?? EMPTY_SNAPSHOT_JSON;
  if (options?.onlyIfChanged && previousJson === snapshotJson) {
    return false;
  }
  scopeCache.set(cacheKey, snapshotJson);
  return true;
}
