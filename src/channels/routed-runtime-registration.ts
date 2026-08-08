import type {
  ExternalToolDefinitionPayload,
  RuntimeExternalToolsUpdateGroup,
  RuntimeScope,
  RuntimeStartExternalToolsGroup,
} from "@/types/app-server-protocol";
import { loadRoutes } from "./routing";
import type { ChannelStartupLogger, ChannelTurnSource } from "./types";

interface RoutedRuntimeSourceResolver {
  resolveRoutedTurnSources(): ChannelTurnSource[];
}

interface RoutedRuntimeToolPublisher {
  getKnownRuntimes?(): RuntimeScope[];
  publish(
    updates: readonly RuntimeExternalToolsUpdateGroup[],
    routedSources: Array<{
      runtime: RuntimeScope;
      sources: ChannelTurnSource[];
    }>,
  ): Promise<void>;
}

type RoutedRuntimeToolBuilder = (
  sources: ChannelTurnSource[],
) => Promise<ExternalToolDefinitionPayload | null>;

type DesiredRuntimeRegistration = {
  runtime: RuntimeScope;
  sources: ChannelTurnSource[];
  externalTools: RuntimeStartExternalToolsGroup[];
  signature: string;
};

function runtimeKey(runtime: RuntimeScope): string {
  return `${runtime.agent_id}:${runtime.conversation_id}`;
}

function groupSourcesByRuntime(
  sources: ChannelTurnSource[],
): Array<{ runtime: RuntimeScope; sources: ChannelTurnSource[] }> {
  const sourcesByRuntime = new Map<
    string,
    { runtime: RuntimeScope; sources: ChannelTurnSource[] }
  >();
  for (const source of sources) {
    const runtime = {
      agent_id: source.agentId,
      conversation_id: source.conversationId,
    };
    const key = runtimeKey(runtime);
    const existing = sourcesByRuntime.get(key);
    if (existing) existing.sources.push(source);
    else sourcesByRuntime.set(key, { runtime, sources: [source] });
  }
  return [...sourcesByRuntime.values()];
}

function toolScopeKey(sources: ChannelTurnSource[]): string {
  return JSON.stringify(
    [
      ...new Set(
        sources.map((source) => `${source.channel}:${source.accountId ?? ""}`),
      ),
    ].sort(),
  );
}

async function buildDesiredRegistrations(
  registry: RoutedRuntimeSourceResolver,
  channelNames: string[],
  buildTool: RoutedRuntimeToolBuilder,
  knownRuntimes: RuntimeScope[],
): Promise<Map<string, DesiredRuntimeRegistration>> {
  for (const channel of channelNames) loadRoutes(channel);
  const groupedSources = groupSourcesByRuntime(
    registry.resolveRoutedTurnSources(),
  );
  const desired = new Map<string, DesiredRuntimeRegistration>();
  // Hundreds of conversations commonly share one channel/account capability
  // set. Resolve and serialize that schema once, then fan it out by runtime.
  const toolsByScope = new Map<
    string,
    Promise<ExternalToolDefinitionPayload | null>
  >();
  await Promise.all(
    groupedSources.map(async ({ runtime, sources }) => {
      const scopeKey = toolScopeKey(sources);
      let toolPromise = toolsByScope.get(scopeKey);
      if (!toolPromise) {
        toolPromise = buildTool(sources);
        toolsByScope.set(scopeKey, toolPromise);
      }
      const tool = await toolPromise;
      const externalTools: RuntimeStartExternalToolsGroup[] = tool
        ? [{ tools: [tool] }]
        : [];
      desired.set(runtimeKey(runtime), {
        runtime,
        sources,
        externalTools,
        signature: JSON.stringify(externalTools),
      });
    }),
  );
  for (const runtime of knownRuntimes) {
    const key = runtimeKey(runtime);
    if (desired.has(key)) continue;
    const externalTools: RuntimeStartExternalToolsGroup[] = [];
    desired.set(key, {
      runtime,
      sources: [],
      externalTools,
      signature: JSON.stringify(externalTools),
    });
  }
  return desired;
}

function buildUpdateGroups(
  desired: Map<string, DesiredRuntimeRegistration>,
  publishedSignatures: Map<
    string,
    { runtime: RuntimeScope; signature: string }
  >,
): RuntimeExternalToolsUpdateGroup[] {
  const groupsBySignature = new Map<
    string,
    {
      runtimes: RuntimeScope[];
      external_tools: RuntimeStartExternalToolsGroup[];
    }
  >();
  const append = (
    runtime: RuntimeScope,
    externalTools: RuntimeStartExternalToolsGroup[],
    signature: string,
  ): void => {
    const existing = groupsBySignature.get(signature);
    if (existing) existing.runtimes.push(runtime);
    else {
      groupsBySignature.set(signature, {
        runtimes: [runtime],
        external_tools: externalTools,
      });
    }
  };

  for (const [key, registration] of desired) {
    if (publishedSignatures.get(key)?.signature === registration.signature) {
      continue;
    }
    append(
      registration.runtime,
      registration.externalTools,
      registration.signature,
    );
  }
  const emptySignature = JSON.stringify([]);
  for (const [key, published] of publishedSignatures) {
    if (!desired.has(key)) append(published.runtime, [], emptySignature);
  }
  return [...groupsBySignature.values()];
}

export function createRoutedRuntimeRegistrationRefresher(options: {
  registry: RoutedRuntimeSourceResolver;
  publisher: RoutedRuntimeToolPublisher;
  channelNames: string[];
  buildTool: RoutedRuntimeToolBuilder;
  logger?: ChannelStartupLogger;
  retryDelayMs?: number;
}): {
  refresh: () => Promise<void>;
  requestRefresh: () => void;
  close: () => void;
} {
  const retryDelayMs = options.retryDelayMs ?? 1000;
  let publishedSignatures = new Map<
    string,
    { runtime: RuntimeScope; signature: string }
  >();
  let pending = Promise.resolve();
  let backgroundRefresh: Promise<void> | null = null;
  let requestedVersion = 0;
  let completedVersion = 0;
  let closed = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let resolveRetry: (() => void) | null = null;

  const runRefresh = async (): Promise<void> => {
    const desired = await buildDesiredRegistrations(
      options.registry,
      options.channelNames,
      options.buildTool,
      options.publisher.getKnownRuntimes?.() ?? [],
    );
    const updates = buildUpdateGroups(desired, publishedSignatures);
    const routedSources = [...desired.values()].map((registration) => ({
      runtime: registration.runtime,
      sources: registration.sources,
    }));
    for (const [key, published] of publishedSignatures) {
      if (!desired.has(key)) {
        routedSources.push({ runtime: published.runtime, sources: [] });
      }
    }
    await options.publisher.publish(updates, routedSources);
    publishedSignatures = new Map(
      [...desired].map(([key, registration]) => [
        key,
        { runtime: registration.runtime, signature: registration.signature },
      ]),
    );
  };
  const refresh = (): Promise<void> => {
    const run = pending.then(runRefresh, runRefresh);
    pending = run.catch(() => undefined);
    return run;
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
          options.logger?.(
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
