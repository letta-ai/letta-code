import type { SubagentSnapshot } from "@/types/protocol_v2";

type SubagentStateScope = {
  agent_id?: string | null;
  conversation_id?: string | null;
};

/** Empty snapshot: a scope never sent any subagents needs no update yet. */
const EMPTY_SNAPSHOT_JSON = "[]";

/**
 * Last subagent snapshot sent per listener runtime and scope. Every emit is
 * recorded, including explicit syncs to a reconnected connection, so the cache
 * always matches what subscribers last received.
 */
const lastSubagentSnapshotByOwner = new WeakMap<object, Map<string, string>>();

export function clearSubagentSnapshotCache(owner: object): void {
  lastSubagentSnapshotByOwner.delete(owner);
}

/**
 * Records `snapshot` as the last one sent for `scope` and reports whether it
 * should be emitted. Explicit state syncs always emit; `onlyIfChanged` skips a
 * snapshot identical to the last one sent for that scope.
 */
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
