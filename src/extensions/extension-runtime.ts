import type Letta from "@letta-ai/letta-client";
import {
  type CreateExtensionHostOptions,
  createExtensionHost,
  type ExtensionHost,
  resolveLocalExtensionSources,
} from "@/extensions/extension-host";
import type {
  ExtensionBackendApi,
  ExtensionContext,
  ExtensionEventEmissionResult,
  ExtensionEventMap,
  ExtensionEventName,
} from "@/extensions/types";
import { debugLog } from "@/utils/debug";

export interface ExtensionRuntimeLoadState {
  hadStatuslineRenderer: boolean;
  hasExtensionSources: boolean;
  isLoading: boolean;
}

export interface ExtensionRuntimeSnapshot extends ExtensionRuntimeLoadState {
  registry: ReturnType<ExtensionHost["getSnapshot"]>;
}

export interface CreateExtensionRuntimeOptions
  extends Omit<CreateExtensionHostOptions, "backend" | "getContext"> {
  getBackendApi?: () => ExtensionBackendApi | undefined;
  getClient: () => Promise<Letta>;
  initialContext: ExtensionContext;
}

export interface ExtensionRuntime {
  dispose: () => void;
  emitEvent: <TName extends ExtensionEventName>(
    name: TName,
    event: ExtensionEventMap[TName],
  ) => Promise<ExtensionEventEmissionResult<TName>>;
  getBackendApi: () => ExtensionBackendApi | undefined;
  getContext: () => ExtensionContext;
  getSnapshot: () => ExtensionRuntimeSnapshot;
  host: ExtensionHost;
  reload: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  updateContext: (context: ExtensionContext) => void;
}

function hasExtensionSources(
  options: Pick<
    CreateExtensionRuntimeOptions,
    "cacheDirectory" | "globalExtensionsDirectory"
  >,
): boolean {
  return resolveLocalExtensionSources(options).some(
    (source) => source.files.length > 0,
  );
}

function createActivationBackendApi(
  getBackendApi: () => ExtensionBackendApi | undefined,
): ExtensionBackendApi {
  const requireBackend = () => {
    const backend = getBackendApi();
    if (!backend) {
      throw new Error("Extension backend is not available");
    }
    return backend;
  };

  return {
    forkConversation(conversationId, options) {
      return requireBackend().forkConversation(conversationId, options);
    },
    sendMessageStream(conversationId, messages, options, requestOptions) {
      return requireBackend().sendMessageStream(
        conversationId,
        messages,
        options,
        requestOptions,
      );
    },
  };
}

export function createExtensionRuntime(
  options: CreateExtensionRuntimeOptions,
): ExtensionRuntime {
  const {
    getBackendApi: resolveBackendApi,
    initialContext,
    ...hostOptions
  } = options;
  let context = initialContext;
  let disposed = false;
  const initialHasExtensionSources = hasExtensionSources(hostOptions);
  let loadState: ExtensionRuntimeLoadState = {
    hadStatuslineRenderer: false,
    hasExtensionSources: initialHasExtensionSources,
    isLoading: initialHasExtensionSources,
  };
  const listeners = new Set<() => void>();

  const getBackendApi = () => resolveBackendApi?.();
  const getContext = () => context;
  const backend = resolveBackendApi
    ? createActivationBackendApi(getBackendApi)
    : undefined;

  const host = createExtensionHost({
    ...hostOptions,
    ...(backend ? { backend } : {}),
    getContext,
  });

  const buildSnapshot = (): ExtensionRuntimeSnapshot => ({
    registry: host.getSnapshot(),
    ...loadState,
  });
  let snapshot = buildSnapshot();

  const publish = () => {
    snapshot = buildSnapshot();
    for (const listener of listeners) {
      listener();
    }
  };
  const unsubscribeHost = host.subscribe(publish);

  const getSnapshot = () => snapshot;

  const reload = async () => {
    if (disposed) return;

    const previousSnapshot = host.getSnapshot();
    const previousHadStatuslineRenderer =
      Boolean(previousSnapshot.ui.statuslineRenderer) ||
      loadState.hadStatuslineRenderer;
    loadState = {
      hadStatuslineRenderer: previousHadStatuslineRenderer,
      hasExtensionSources: hasExtensionSources(hostOptions),
      isLoading: true,
    };
    publish();

    await host.reload();
    if (disposed) return;

    const nextRegistry = host.getSnapshot();
    debugLog(
      "extensions",
      "loaded %s extension(s) from %s source(s); renderer=%s",
      nextRegistry.loadedPaths.length,
      nextRegistry.sources.length,
      nextRegistry.ui.statuslineRenderer?.id ?? "(none)",
    );

    for (const loadError of nextRegistry.errors) {
      debugLog(
        "extensions",
        "failed to load %s: %s",
        loadError.path,
        loadError.error.message,
      );
    }

    loadState = {
      hadStatuslineRenderer: Boolean(nextRegistry.ui.statuslineRenderer),
      hasExtensionSources: nextRegistry.sources.some(
        (source) => source.files.length > 0,
      ),
      isLoading: false,
    };
    publish();
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      host.dispose();
      unsubscribeHost();
      listeners.clear();
    },
    emitEvent(name, event) {
      return host.emitEvent(name, event, getBackendApi());
    },
    getBackendApi,
    getContext,
    getSnapshot,
    host,
    reload,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateContext(nextContext) {
      context = nextContext;
    },
  };
}
