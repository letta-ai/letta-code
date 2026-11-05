/**
 * Long-lived background work (script Monitors) keeps calling tools against the
 * turn-scoped execution context it launched from. The TUI releases that
 * context when the turn ends, and the store evicts the oldest contexts, so a
 * holder retains the context here; release and eviction defer until the last
 * holder lets go.
 */
const holders = new Map<string, number>();
const deferredReleases = new Set<string>();

export function retainToolContext(contextId: string): void {
  holders.set(contextId, (holders.get(contextId) ?? 0) + 1);
}

/** Returns true when a deferred release should now run. */
export function releaseRetainedToolContext(contextId: string): boolean {
  const count = (holders.get(contextId) ?? 0) - 1;
  if (count > 0) {
    holders.set(contextId, count);
    return false;
  }
  holders.delete(contextId);
  return deferredReleases.delete(contextId);
}

export function isToolContextRetained(contextId: string): boolean {
  return holders.has(contextId);
}

/** Records a release requested while the context is retained. */
export function deferToolContextRelease(contextId: string): boolean {
  if (!holders.has(contextId)) return false;
  deferredReleases.add(contextId);
  return true;
}
