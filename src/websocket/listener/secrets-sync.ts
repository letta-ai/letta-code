/**
 * Server-backed secrets hydration for listen mode.
 *
 * Listen-mode clients can update agent secrets directly through the API. The
 * listener process still needs a fresh local cache before it builds reminders
 * or executes shell tools that use $SECRET_NAME references.
 *
 * Caching strategy:
 * - Completed refreshes are cached for a configurable freshness window
 *   (default 60 s) so that the same-turn approval path and rapid sequential
 *   turns don't re-fetch.
 * - Mutation paths (secret_apply, setSecretOnServer, deleteSecretOnServer)
 *   mark the agent's cache dirty so the next hydration call re-fetches.
 * - Concurrent callers for the same agent still coalesce onto a single
 *   in-flight request.
 */

import { debugLog, debugWarn } from "../../utils/debug";
import type { ListenerRuntime } from "./types";

/** Default freshness window in milliseconds. */
const DEFAULT_FRESHNESS_MS = 60_000;

/** Test-only override for the freshness window. */
let _testFreshnessMsOverride: number | null = null;

/** @internal */
export function __testSetFreshnessMs(ms: number | null): void {
  _testFreshnessMsOverride = ms;
}

function getFreshnessMs(): number {
  return _testFreshnessMsOverride ?? DEFAULT_FRESHNESS_MS;
}

let _testRefreshSecretsForAgentOverride:
  | ((agentId: string) => Promise<void>)
  | null = null;

export function __testOverrideRefreshSecretsForAgent(
  factory: ((agentId: string) => Promise<void>) | null,
): void {
  _testRefreshSecretsForAgentOverride = factory;
}

async function refreshSecretsForAgent(agentId: string): Promise<void> {
  if (_testRefreshSecretsForAgentOverride) {
    await _testRefreshSecretsForAgentOverride(agentId);
    debugLog("secrets-sync", `Refreshed secrets for agent ${agentId}`);
    return;
  }

  const { initSecretsFromServer } = await import("../../utils/secretsStore");
  await initSecretsFromServer(agentId);
  debugLog("secrets-sync", `Refreshed secrets for agent ${agentId}`);
}

/**
 * Mark an agent's cached secrets as stale so the next hydration call
 * re-fetches from the server.
 *
 * Call this from mutation paths (secret_apply, setSecretOnServer,
 * deleteSecretOnServer) so that subsequent tool executions see the
 * updated values without waiting for the freshness window to expire.
 */
export function invalidateSecretsCacheForAgent(
  listener: ListenerRuntime,
  agentId: string,
): void {
  listener.secretsDirtyAgents.add(agentId);
  debugLog("secrets-sync", `Marked secrets cache dirty for agent ${agentId}`);
}

/**
 * Check whether an agent's cached secrets are still fresh.
 *
 * Returns true when:
 *  - the agent has been hydrated before, AND
 *  - the last hydration time is within the freshness window, AND
 *  - the agent is not marked dirty.
 */
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

/**
 * Refresh the in-memory secrets cache for an agent.
 *
 * Concurrent callers for the same agent coalesce onto a single in-flight
 * request. Completed refreshes are cached for a freshness window so that
 * rapid sequential calls (e.g. turn preflight + approval execution) reuse
 * the same hydration without a duplicate server round-trip.
 *
 * Mutation paths invalidate the cache via `invalidateSecretsCacheForAgent`
 * so the next call always re-fetches after a GUI secret update.
 *
 * Non-fatal: logs a warning on failure but doesn't throw.
 */
export async function ensureSecretsHydratedForAgent(
  listener: ListenerRuntime,
  agentId: string,
): Promise<void> {
  while (true) {
    // Fast path: cache is still fresh and not dirty.
    if (isSecretsCacheFresh(listener, agentId)) {
      debugLog(
        "secrets-sync",
        `Secrets cache hit for agent ${agentId} (age ${Date.now() - (listener.secretsHydrationFreshnessByAgent.get(agentId) ?? 0)}ms)`,
      );
      return;
    }

    // Coalesce concurrent callers onto the same in-flight request. If a
    // mutation marks the agent dirty while that request is in flight, loop back
    // after it settles so the post-mutation caller forces a fresh hydration
    // instead of satisfying itself from the stale promise.
    const existing = listener.secretsHydrationByAgent.get(agentId);
    if (existing) {
      await existing;
      if (listener.secretsDirtyAgents.has(agentId)) {
        continue;
      }
      return;
    }

    // Clear dirty flag before fetching so the fresh result is not immediately
    // considered stale. A mutation during the fetch will set it again and the
    // loop will run another hydration before returning to that caller.
    listener.secretsDirtyAgents.delete(agentId);

    const promise = refreshSecretsForAgent(agentId)
      .then(() => {
        // Record freshness timestamp on successful hydration.
        listener.secretsHydrationFreshnessByAgent.set(agentId, Date.now());
      })
      .catch((err) => {
        // Non-fatal — agent can still process messages, just without local
        // secret substitution for this turn/tool execution.
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
