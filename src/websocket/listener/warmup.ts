import { getClient } from "../../backend/api/client";
import { debugWarn } from "../../utils/debug";
import { ensureMemfsSyncedForAgent } from "./memfs-sync";
import { ensureSecretsHydratedForAgent } from "./secrets-sync";
import type { ListenerRuntime } from "./types";

export type ListenerAgentMetadata = {
  name: string | null;
  description: string | null;
  lastRunAt: string | null;
};

export type ListenerWarmupScope = {
  agentId: string;
  conversationId: string;
};

function getAgentMetadataPromise(
  listener: ListenerRuntime,
  agentId: string,
): Promise<ListenerAgentMetadata | null> | null {
  return listener.agentMetadataByAgent.get(agentId) ?? null;
}

async function fetchListenerAgentMetadata(
  agentId: string,
): Promise<ListenerAgentMetadata> {
  const client = await getClient();
  const agent = await client.agents.retrieve(agentId);

  return {
    name: agent.name ?? null,
    description: agent.description ?? null,
    lastRunAt:
      (agent as { last_run_completion?: string | null }).last_run_completion ??
      null,
  };
}

type ListenerWarmupDeps = {
  ensureMemfsSyncedForAgent: typeof ensureMemfsSyncedForAgent;
  ensureSecretsHydratedForAgent: typeof ensureSecretsHydratedForAgent;
  fetchListenerAgentMetadata: typeof fetchListenerAgentMetadata;
};

const defaultWarmupDeps: ListenerWarmupDeps = {
  ensureMemfsSyncedForAgent,
  ensureSecretsHydratedForAgent,
  fetchListenerAgentMetadata,
};

let warmupDeps: ListenerWarmupDeps = defaultWarmupDeps;

/**
 * Hydrate listener-side state needed for the next turn.
 *
 * The warmup is intentionally best-effort: failures are logged and do not
 * block the user turn, mirroring the existing preflight behavior.
 */
export async function ensureListenerWarmStateForTurn(
  listener: ListenerRuntime,
  scope: ListenerWarmupScope,
): Promise<ListenerAgentMetadata | null> {
  const { agentId } = scope;
  if (!agentId) {
    return null;
  }

  const agentMetadataPromise =
    getAgentMetadataPromise(listener, agentId) ??
    (async () => {
      try {
        return await warmupDeps.fetchListenerAgentMetadata(agentId);
      } catch (error) {
        debugWarn(
          "listener-warmup",
          `Failed to fetch agent metadata for agent ${agentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        listener.agentMetadataByAgent.delete(agentId);
        return null;
      }
    })();

  if (!listener.agentMetadataByAgent.has(agentId)) {
    listener.agentMetadataByAgent.set(agentId, agentMetadataPromise);
  }

  try {
    await Promise.all([
      warmupDeps.ensureMemfsSyncedForAgent(listener, agentId),
      warmupDeps.ensureSecretsHydratedForAgent(listener, agentId),
      agentMetadataPromise,
    ]);
  } catch (error) {
    debugWarn(
      "listener-warmup",
      `Listener warmup failed for agent ${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return agentMetadataPromise;
}

/**
 * Start background warmups after sync without delaying the sync response.
 */
export function scheduleListenerWarmupsAfterSync(
  listener: ListenerRuntime,
  scope: Partial<ListenerWarmupScope> & {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const agentId = scope.agentId ?? scope.agent_id ?? null;
  const conversationId = scope.conversationId ?? scope.conversation_id ?? null;
  if (!agentId) {
    return;
  }

  void ensureListenerWarmStateForTurn(listener, {
    agentId,
    conversationId: conversationId ?? "default",
  }).catch((error) => {
    debugWarn(
      "listener-warmup",
      `Background listener warmup failed for agent ${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

export function clearListenerWarmState(listener: ListenerRuntime): void {
  listener.agentMetadataByAgent.clear();
}

export const __listenerWarmupTestUtils = {
  setWarmupDepsForTests(overrides: Partial<ListenerWarmupDeps>): void {
    warmupDeps = { ...defaultWarmupDeps, ...overrides };
  },
  resetWarmupDepsForTests(): void {
    warmupDeps = defaultWarmupDeps;
  },
};
