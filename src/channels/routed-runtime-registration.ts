import type { RuntimeScope } from "@/types/app-server-protocol";
import { loadRoutes } from "./routing";
import type { ChannelStartupLogger, ChannelTurnSource } from "./types";

interface RoutedRuntimeSourceResolver {
  resolveRoutedTurnSources(): ChannelTurnSource[];
}

interface RoutedRuntimeRegistrar {
  getKnownRuntimes(): RuntimeScope[];
  registerRuntime(
    runtime: RuntimeScope,
    sources?: ChannelTurnSource[],
  ): Promise<void>;
}

async function refreshRoutedRuntimeRegistrations(
  registry: RoutedRuntimeSourceResolver,
  gateway: RoutedRuntimeRegistrar,
  channelNames: string[],
): Promise<void> {
  const sourcesByRuntime = new Map<
    string,
    { runtime: RuntimeScope; sources: ChannelTurnSource[] }
  >();
  for (const channel of channelNames) {
    loadRoutes(channel);
  }
  for (const source of registry.resolveRoutedTurnSources()) {
    const runtime = {
      agent_id: source.agentId,
      conversation_id: source.conversationId,
    };
    const key = `${runtime.agent_id}:${runtime.conversation_id}`;
    const existing = sourcesByRuntime.get(key);
    if (existing) {
      existing.sources.push(source);
    } else {
      sourcesByRuntime.set(key, { runtime, sources: [source] });
    }
  }
  for (const runtime of gateway.getKnownRuntimes()) {
    const key = `${runtime.agent_id}:${runtime.conversation_id}`;
    if (!sourcesByRuntime.has(key)) {
      sourcesByRuntime.set(key, { runtime, sources: [] });
    }
  }

  for (const { runtime, sources } of sourcesByRuntime.values()) {
    await gateway.registerRuntime(runtime, sources);
  }
}

export function createRoutedRuntimeRegistrationRefresher(
  registry: RoutedRuntimeSourceResolver,
  gateway: RoutedRuntimeRegistrar,
  channelNames: string[],
  logger?: ChannelStartupLogger,
  retryDelayMs = 1000,
): {
  refresh: () => Promise<void>;
  requestRefresh: () => void;
  close: () => void;
} {
  let pending = Promise.resolve();
  let backgroundRefresh: Promise<void> | null = null;
  let requestedVersion = 0;
  let completedVersion = 0;
  let closed = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let resolveRetry: (() => void) | null = null;

  const refresh = (): Promise<void> => {
    const run = () =>
      refreshRoutedRuntimeRegistrations(registry, gateway, channelNames);
    pending = pending.then(run, run);
    return pending;
  };
  const waitForRetry = (): Promise<void> =>
    new Promise((resolve) => {
      resolveRetry = resolve;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        resolveRetry = null;
        resolve();
      }, retryDelayMs);
      retryTimer.unref?.();
    });
  const startBackgroundRefresh = (): void => {
    if (closed || backgroundRefresh) return;
    backgroundRefresh = (async () => {
      while (!closed) {
        const version = requestedVersion;
        try {
          await refresh();
          completedVersion = version;
          if (version === requestedVersion) return;
        } catch (error) {
          logger?.(
            `[ChannelGateway] Failed to refresh routed runtimes; retrying: ${error instanceof Error ? error.message : String(error)}`,
          );
          await waitForRetry();
        }
      }
    })().finally(() => {
      backgroundRefresh = null;
      if (!closed && completedVersion < requestedVersion) {
        startBackgroundRefresh();
      }
    });
  };
  const requestRefresh = (): void => {
    if (closed) return;
    requestedVersion++;
    startBackgroundRefresh();
  };
  const close = (): void => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    resolveRetry?.();
    resolveRetry = null;
  };

  return { refresh, requestRefresh, close };
}
