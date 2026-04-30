/**
 * Server-backed secrets hydration for listen mode.
 *
 * Desktop and other WebSocket clients can update agent secrets directly through
 * the API. The listener process still needs a fresh local cache before it
 * builds reminders or executes shell tools that use $SECRET_NAME references.
 */

import { debugLog, debugWarn } from "../../utils/debug";
import type { ListenerRuntime } from "./types";

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
 * Refresh the in-memory secrets cache for an agent.
 *
 * Concurrent callers for the same agent coalesce onto a single in-flight
 * request, but completed refreshes are not memoized. That keeps desktop GUI
 * updates visible on the next turn / tool execution without requiring a
 * listener restart.
 *
 * Non-fatal: logs a warning on failure but doesn't throw.
 */
export async function ensureSecretsHydratedForAgent(
  listener: ListenerRuntime,
  agentId: string,
): Promise<void> {
  const existing = listener.secretsHydrationByAgent.get(agentId);
  if (existing) {
    await existing;
    return;
  }

  const promise = refreshSecretsForAgent(agentId)
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
}
