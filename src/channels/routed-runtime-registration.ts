import type { RuntimeScope } from "@/types/app-server-protocol";
import type { ChannelRegistry } from "./registry";
import type { ChannelStartupLogger, ChannelTurnSource } from "./types";

interface RoutedRuntimeRegistrar {
  getKnownRuntimes(): RuntimeScope[];
  registerRuntime(
    runtime: RuntimeScope,
    sources?: ChannelTurnSource[],
  ): Promise<void>;
}

async function refreshRoutedRuntimeRegistrations(
  registry: ChannelRegistry,
  gateway: RoutedRuntimeRegistrar,
  logger?: ChannelStartupLogger,
): Promise<void> {
  const routedByRuntime = new Map(
    registry
      .resolveRoutedRuntimeSources()
      .map((routed) => [`${routed.agentId}:${routed.conversationId}`, routed]),
  );
  for (const runtime of gateway.getKnownRuntimes()) {
    const key = `${runtime.agent_id}:${runtime.conversation_id}`;
    if (!routedByRuntime.has(key)) {
      routedByRuntime.set(key, {
        agentId: runtime.agent_id,
        conversationId: runtime.conversation_id,
        sources: [],
      });
    }
  }
  for (const routed of routedByRuntime.values()) {
    try {
      await gateway.registerRuntime(
        {
          agent_id: routed.agentId,
          conversation_id: routed.conversationId,
        },
        routed.sources,
      );
    } catch (error) {
      logger?.(
        `[ChannelGateway] Failed to refresh routed runtime ${routed.agentId}/${routed.conversationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function createRoutedRuntimeRegistrationRefresher(
  registry: ChannelRegistry,
  gateway: RoutedRuntimeRegistrar,
  logger?: ChannelStartupLogger,
): { refresh: () => Promise<void> } {
  let pending = Promise.resolve();
  return {
    refresh: () => {
      pending = pending.then(() =>
        refreshRoutedRuntimeRegistrations(registry, gateway, logger),
      );
      return pending;
    },
  };
}
