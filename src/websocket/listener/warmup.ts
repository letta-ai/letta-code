import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import { ensureMemfsSyncedForAgent } from "./memfs-sync";
import { ensureListenerAgentModAdapter } from "./mod-adapter";
import { emitDeviceStatusUpdateIfChanged } from "./protocol-outbound";
import { ensureSecretsHydratedForAgent } from "./secrets-sync";
import { isListenerTransportOpen } from "./transport";
import type { ListenerRuntime } from "./types";

export type ListenerAgentMetadata = {
  name: string | null;
  description: string | null;
  lastRunAt: string | null;
};

export type ListenerAgentWarmState = ListenerAgentMetadata & {
  /** Full agent state (tags included) reused by turn prep; null if unavailable. */
  agent: AgentState | null;
};

export type ListenerWarmupScope = {
  agentId: string;
  conversationId: string;
};

function getAgentWarmStatePromise(
  listener: ListenerRuntime,
  agentId: string,
): Promise<ListenerAgentWarmState | null> | null {
  return listener.agentMetadataByAgent.get(agentId) ?? null;
}

function toListenerAgentWarmState(agent: AgentState): ListenerAgentWarmState {
  return {
    name: agent.name ?? null,
    description: agent.description ?? null,
    lastRunAt:
      (agent as { last_run_completion?: string | null }).last_run_completion ??
      null,
    agent,
  };
}

async function fetchListenerAgentWarmState(
  agentId: string,
): Promise<ListenerAgentWarmState> {
  const agent = (await getBackend().retrieveAgent(agentId, {
    include: ["agent.tags"],
  })) as AgentState;

  return toListenerAgentWarmState(agent);
}

type ListenerWarmupDeps = {
  ensureMemfsSyncedForAgent: typeof ensureMemfsSyncedForAgent;
  ensureSecretsHydratedForAgent: typeof ensureSecretsHydratedForAgent;
  fetchListenerAgentWarmState: typeof fetchListenerAgentWarmState;
};

const defaultWarmupDeps: ListenerWarmupDeps = {
  ensureMemfsSyncedForAgent,
  ensureSecretsHydratedForAgent,
  fetchListenerAgentWarmState,
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
): Promise<ListenerAgentWarmState | null> {
  const { agentId } = scope;
  if (!agentId) {
    return null;
  }

  const agentMetadataPromise =
    getAgentWarmStatePromise(listener, agentId) ??
    (async () => {
      try {
        return await warmupDeps.fetchListenerAgentWarmState(agentId);
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
      // Memfs reuses the warm-state agent fetch (tags included) instead of
      // issuing its own retrieve; on a failed fetch it falls back internally.
      agentMetadataPromise.then((warmState) =>
        warmupDeps.ensureMemfsSyncedForAgent(
          listener,
          agentId,
          warmState?.agent ?? null,
        ),
      ),
      warmupDeps.ensureSecretsHydratedForAgent(listener, agentId),
    ]);
    const agentModAdapter = await ensureListenerAgentModAdapter(
      listener,
      agentId,
    );
    const transport = listener.transport ?? listener.socket;
    if (agentModAdapter && transport && isListenerTransportOpen(transport)) {
      emitDeviceStatusUpdateIfChanged(transport, listener, {
        agent_id: agentId,
        conversation_id: scope.conversationId,
      });
    }
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

const inflightWarmStateRefreshes = new WeakMap<ListenerRuntime, Set<string>>();

function scheduleListenerAgentWarmStateRefresh(
  listener: ListenerRuntime,
  agentId: string,
): void {
  let inflight = inflightWarmStateRefreshes.get(listener);
  if (!inflight) {
    inflight = new Set();
    inflightWarmStateRefreshes.set(listener, inflight);
  }
  if (inflight.has(agentId)) {
    return;
  }
  inflight.add(agentId);
  void (async () => {
    try {
      const fresh = await warmupDeps.fetchListenerAgentWarmState(agentId);
      listener.agentMetadataByAgent.set(agentId, Promise.resolve(fresh));
    } catch (error) {
      // Keep serving the existing cache; the next turn retries the refresh.
      debugWarn(
        "listener-warmup",
        `Background agent state refresh failed for agent ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      inflight.delete(agentId);
    }
  })();
}

/**
 * Agent state for turn prep, served from the session cache without a blocking
 * refetch. A background refresh runs on every cache hit so external changes
 * converge by the next turn — the same freshness headless accepts by reusing
 * its initial agent fetch across the whole run loop.
 */
export async function getListenerAgentStateForTurn(
  listener: ListenerRuntime,
  agentId: string,
): Promise<AgentState | null> {
  const cached = await getAgentWarmStatePromise(listener, agentId);
  if (cached?.agent) {
    scheduleListenerAgentWarmStateRefresh(listener, agentId);
    return cached.agent;
  }

  try {
    const fetched = await warmupDeps.fetchListenerAgentWarmState(agentId);
    listener.agentMetadataByAgent.set(agentId, Promise.resolve(fetched));
    return fetched.agent;
  } catch (error) {
    debugWarn(
      "listener-warmup",
      `Failed to fetch agent state for agent ${agentId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/** Replace the cached warm state after a local mutation returned fresh agent state. */
export function setListenerAgentWarmState(
  listener: ListenerRuntime,
  agent: AgentState,
): void {
  listener.agentMetadataByAgent.set(
    agent.id,
    Promise.resolve(toListenerAgentWarmState(agent)),
  );
}

/** Drop the cached warm state so the next turn refetches (e.g. after a model update). */
export function invalidateListenerAgentWarmState(
  listener: ListenerRuntime,
  agentId: string,
): void {
  listener.agentMetadataByAgent.delete(agentId);
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
