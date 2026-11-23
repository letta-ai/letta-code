const holders = new Map<string, number>();
const deferredReleases = new Set<string>();

export function retainToolContext(contextId: string): void {
  holders.set(contextId, (holders.get(contextId) ?? 0) + 1);
}

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

export function deferToolContextRelease(contextId: string): boolean {
  if (!holders.has(contextId)) return false;
  deferredReleases.add(contextId);
  return true;
}
