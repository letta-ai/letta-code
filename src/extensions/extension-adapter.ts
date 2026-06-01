import type Letta from "@letta-ai/letta-client";
import { clearRegisteredPiProviders } from "@/backend/dev/pi-provider-extension-registry";
import {
  cloneExtensionCapabilities,
  DISABLED_EXTENSION_CAPABILITIES,
} from "@/extensions/capabilities";
import {
  areExtensionsDisabled,
  disableExtensionsForProcess,
} from "@/extensions/disable";
import {
  type ExtensionEventEmitter,
  emptyEventEmissionResult,
} from "@/extensions/event-emitter";
import {
  type CreateExtensionEngineOptions,
  createExtensionEngine,
  type ExtensionEngine,
  type LocalExtensionRegistry,
  resolveLocalExtensionSources,
} from "@/extensions/extension-engine";
import { clearExtensionTools } from "@/extensions/tool-registry";
import type {
  ExtensionAdapterBackendApi,
  ExtensionContext,
  ExtensionEventEmissionResult,
  ExtensionEventMap,
  ExtensionEventName,
} from "@/extensions/types";
import { debugLog } from "@/utils/debug";

export interface ExtensionAdapterLoadState {
  hadStatuslineRenderer: boolean;
  hasExtensionSources: boolean;
  isLoading: boolean;
}

export interface ExtensionAdapterSnapshot extends ExtensionAdapterLoadState {
  registry: ReturnType<ExtensionEngine["getSnapshot"]>;
}

export interface CreateExtensionAdapterOptions
  extends Omit<CreateExtensionEngineOptions, "backend" | "getContext"> {
  disabled?: boolean;
  getBackendApi?: () => ExtensionAdapterBackendApi | undefined;
  getClient: () => Promise<Letta>;
  initialContext: ExtensionContext;
}

function createDisabledExtensionRegistry(): LocalExtensionRegistry {
  return {
    capabilities: cloneExtensionCapabilities(DISABLED_EXTENSION_CAPABILITIES),
    commands: {},
    diagnostics: [],
    disposers: [],
    errors: [],
    events: {},
    generation: 0,
    loadedPaths: [],
    ownerAbortControllers: {},
    owners: {},
    sources: [],
    tools: {},
    ui: {
      panels: {},
      statuslineRenderer: null,
      statusOwners: {},
      statusValues: {},
    },
  };
}

function createDisabledExtensionEngine(
  registry: LocalExtensionRegistry,
): ExtensionEngine {
  return {
    dispose() {},
    emitEvent(name) {
      return Promise.resolve(emptyEventEmissionResult(name));
    },
    getSnapshot() {
      return registry;
    },
    reload() {
      return Promise.resolve();
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function createDisabledExtensionAdapter(
  options: CreateExtensionAdapterOptions,
): ExtensionAdapter {
  clearExtensionTools();
  clearRegisteredPiProviders();

  let context = options.initialContext;
  const registry = createDisabledExtensionRegistry();
  const engine = createDisabledExtensionEngine(registry);
  const snapshot: ExtensionAdapterSnapshot = {
    hadStatuslineRenderer: false,
    hasExtensionSources: false,
    isLoading: false,
    registry,
  };
  const eventEmitter: ExtensionEventEmitter = {
    emitEvent(name) {
      return Promise.resolve(emptyEventEmissionResult(name));
    },
    getSnapshot() {
      return snapshot;
    },
  };

  return {
    dispose() {},
    emitEvent(name) {
      return Promise.resolve(emptyEventEmissionResult(name));
    },
    eventEmitter,
    getBackendApi() {
      return undefined;
    },
    getContext() {
      return context;
    },
    getSnapshot() {
      return snapshot;
    },
    engine,
    reload() {
      return Promise.resolve();
    },
    subscribe() {
      return () => undefined;
    },
    updateContext(nextContext) {
      context = nextContext;
    },
  };
}

export interface ExtensionAdapter {
  dispose: () => void;
  emitEvent: <TName extends ExtensionEventName>(
    name: TName,
    event: ExtensionEventMap[TName],
  ) => Promise<ExtensionEventEmissionResult<TName>>;
  eventEmitter: ExtensionEventEmitter;
  getBackendApi: () => ExtensionAdapterBackendApi | undefined;
  getContext: () => ExtensionContext;
  getSnapshot: () => ExtensionAdapterSnapshot;
  engine: ExtensionEngine;
  reload: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  updateContext: (context: ExtensionContext) => void;
}

function hasExtensionSources(
  options: Pick<
    CreateExtensionAdapterOptions,
    "cacheDirectory" | "globalExtensionsDirectory"
  >,
): boolean {
  return resolveLocalExtensionSources(options).some(
    (source) => source.files.length > 0,
  );
}

function createLazyAdapterBackendApi(
  getBackendApi: () => ExtensionAdapterBackendApi | undefined,
): ExtensionAdapterBackendApi {
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
    getConversationHistory(conversationId, options) {
      return requireBackend().getConversationHistory(conversationId, options);
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

export function createExtensionAdapter(
  options: CreateExtensionAdapterOptions,
): ExtensionAdapter {
  if (options.disabled) {
    disableExtensionsForProcess();
  }

  if (options.disabled || areExtensionsDisabled()) {
    return createDisabledExtensionAdapter(options);
  }

  const {
    getBackendApi: resolveBackendApi,
    initialContext,
    ...engineOptions
  } = options;
  let context = initialContext;
  let disposed = false;
  const initialHasExtensionSources = hasExtensionSources(engineOptions);
  let loadState: ExtensionAdapterLoadState = {
    hadStatuslineRenderer: false,
    hasExtensionSources: initialHasExtensionSources,
    isLoading: initialHasExtensionSources,
  };
  const listeners = new Set<() => void>();

  const getBackendApi = () => resolveBackendApi?.();
  const getContext = () => context;
  const backend = resolveBackendApi
    ? createLazyAdapterBackendApi(getBackendApi)
    : undefined;

  const engine = createExtensionEngine({
    ...engineOptions,
    ...(backend ? { backend } : {}),
    getContext,
  });

  const eventEmitter: ExtensionEventEmitter = {
    emitEvent(name, event) {
      return engine.emitEvent(name, event, getBackendApi());
    },
    getSnapshot() {
      return loadState;
    },
  };

  const buildSnapshot = (): ExtensionAdapterSnapshot => ({
    registry: engine.getSnapshot(),
    ...loadState,
  });
  let snapshot = buildSnapshot();

  const publish = () => {
    snapshot = buildSnapshot();
    for (const listener of listeners) {
      listener();
    }
  };
  const unsubscribeEngine = engine.subscribe(publish);

  const getSnapshot = () => snapshot;

  const reload = async () => {
    if (disposed) return;

    const previousSnapshot = engine.getSnapshot();
    const previousHadStatuslineRenderer =
      Boolean(previousSnapshot.ui.statuslineRenderer) ||
      loadState.hadStatuslineRenderer;
    loadState = {
      hadStatuslineRenderer: previousHadStatuslineRenderer,
      hasExtensionSources: hasExtensionSources(engineOptions),
      isLoading: true,
    };
    publish();

    await engine.reload();
    if (disposed) return;

    const nextRegistry = engine.getSnapshot();
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
      engine.dispose();
      unsubscribeEngine();
      listeners.clear();
    },
    emitEvent(name, event) {
      return engine.emitEvent(name, event, getBackendApi());
    },
    eventEmitter,
    getBackendApi,
    getContext,
    getSnapshot,
    engine,
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
