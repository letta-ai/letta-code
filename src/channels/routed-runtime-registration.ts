import type { RuntimeScope } from "@/types/app-server-protocol";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "./accounts";
import type { ChannelRegistry } from "./registry";
import { getRoutesForChannel, loadRoutes } from "./routing";
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
  channelNames: string[],
  logger?: ChannelStartupLogger,
): Promise<void> {
  const routedByRuntime = new Map<
    string,
    { runtime: RuntimeScope; sources: ChannelTurnSource[] }
  >();
  const sourceKeys = new Set<string>();
  for (const channel of channelNames) {
    loadRoutes(channel);
    for (const route of getRoutesForChannel(channel)) {
      const accountId = route.accountId ?? LEGACY_CHANNEL_ACCOUNT_ID;
      if (
        route.enabled === false ||
        route.outboundEnabled === false ||
        !registry.getAdapter(channel, accountId)?.isRunning()
      )
        continue;
      const key = `${route.agentId}:${route.conversationId}`;
      const routed = routedByRuntime.get(key) ?? {
        runtime: {
          agent_id: route.agentId,
          conversation_id: route.conversationId,
        },
        sources: [],
      };
      routedByRuntime.set(key, routed);
      const sourceKey = `${channel}:${accountId}:${route.chatId}:${route.threadId ?? ""}`;
      if (sourceKeys.has(`${key}:${sourceKey}`)) continue;
      sourceKeys.add(`${key}:${sourceKey}`);
      routed.sources.push({
        channel,
        accountId,
        chatId: route.chatId,
        chatType: route.chatType,
        threadId: route.threadId ?? null,
        agentId: route.agentId,
        conversationId: route.conversationId,
      });
    }
  }
  for (const runtime of gateway.getKnownRuntimes()) {
    const key = `${runtime.agent_id}:${runtime.conversation_id}`;
    if (!routedByRuntime.has(key)) {
      routedByRuntime.set(key, { runtime, sources: [] });
    }
  }
  for (const { runtime, sources } of routedByRuntime.values()) {
    try {
      await gateway.registerRuntime(runtime, sources);
    } catch (error) {
      logger?.(
        `[ChannelGateway] Failed to refresh routed runtime ${runtime.agent_id}/${runtime.conversation_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function createRoutedRuntimeRegistrationRefresher(
  registry: ChannelRegistry,
  gateway: RoutedRuntimeRegistrar,
  channelNames: string[],
  logger?: ChannelStartupLogger,
): { refresh: () => Promise<void> } {
  let pending = Promise.resolve();
  return {
    refresh: () => {
      const run = () =>
        refreshRoutedRuntimeRegistrations(
          registry,
          gateway,
          channelNames,
          logger,
        );
      pending = pending.then(run, run);
      return pending;
    },
  };
}
