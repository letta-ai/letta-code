import { debugLog, debugWarn } from "@/utils/debug";
import type { ListenerRuntime } from "./types";

const DEFAULT_FRESHNESS_MS = 60_000;

let _testFreshnessMsOverride: number | null = null;

export function __testSetFreshnessMs(ms: number | null): void {
  _testFreshnessMsOverride = ms;
}

function getFreshnessMs(): number {
  return _testFreshnessMsOverride ?? DEFAULT_FRESHNESS_MS;
}

async function refreshSecretsForAgent(agentId: string): Promise<void> {
  const { initSecretsFromServer } = await import("@/utils/secrets-store");
  await initSecretsFromServer(agentId);
  debugLog("secrets-sync", `Refreshed secrets for agent ${agentId}`);
}

export function invalidateSecretsCacheForAgent(
  listener: ListenerRuntime,
  agentId: string,
): void {
  listener.secretsDirtyAgents.add(agentId);
  debugLog("secrets-sync", `Marked secrets cache dirty for agent ${agentId}`);
}

function isSecretsCacheFresh(
  listener: ListenerRuntime,
  agentId: string,
): boolean {
  if (listener.secretsDirtyAgents.has(agentId)) {
    return false;
  }
  const lastHydrated = listener.secretsHydrationFreshnessByAgent.get(agentId);
  if (lastHydrated === undefined) {
    return false;
  }
  return Date.now() - lastHydrated < getFreshnessMs();
}

export async function ensureSecretsHydratedForAgent(
  listener: ListenerRuntime,
  agentId: string,
): Promise<void> {
  while (true) {
    if (isSecretsCacheFresh(listener, agentId)) {
      debugLog(
        "secrets-sync",
        `Secrets cache hit for agent ${agentId} (age ${Date.now() - (listener.secretsHydrationFreshnessByAgent.get(agentId) ?? 0)}ms)`,
      );
      return;
    }

    const existing = listener.secretsHydrationByAgent.get(agentId);
    if (existing) {
      await existing;
      if (listener.secretsDirtyAgents.has(agentId)) {
        continue;
      }
      return;
    }

    listener.secretsDirtyAgents.delete(agentId);

    const promise = refreshSecretsForAgent(agentId)
      .then(() => {
        listener.secretsHydrationFreshnessByAgent.set(agentId, Date.now());
      })
      .catch((err) => {
        debugWarn(
          "secrets-sync",
          `Failed to refresh secrets for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        if (listener.secretsHydrationByAgent.get(agentId) === promise) {
          listener.secretsHydrationByAgent.delete(agentId);
        }
      });

    listener.secretsHydrationByAgent.set(agentId, promise);
    await promise;
    if (listener.secretsDirtyAgents.has(agentId)) {
      continue;
    }
    return;
  }
}
