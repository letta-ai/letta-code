import type { Backend } from "@/backend";
import {
  areExtensionsDisabled,
  disableExtensionsForProcess,
} from "@/extensions/disable";
import { createDisabledExtensionAdapter } from "@/extensions/disabled-extension-adapter";
import {
  type ExtensionEvents,
  emptyEventEmissionResult,
} from "@/extensions/event-emitter";
import {
  type CreateExtensionEngineOptions,
  createExtensionEngine,
  type ExtensionEngine,
  resolveLocalExtensionSources,
} from "@/extensions/extension-engine";
import type { ExtensionContext } from "@/extensions/types";
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
  extends Omit<CreateExtensionEngineOptions, "getContext"> {
  disabled?: boolean;
  initialContext: ExtensionContext;
}

export interface ExtensionAdapter {
  dispose: () => void;
  events: ExtensionEvents;
  getBackend: () => Backend | undefined;
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
    getBackend: resolveBackend,
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

  const getBackend = () => resolveBackend?.();
  const getContext = () => context;

  const engine = createExtensionEngine({
    ...engineOptions,
    ...(resolveBackend ? { getBackend } : {}),
    getContext,
  });

  const events: ExtensionEvents = {
    emit(name, event) {
      if (loadState.isLoading || !loadState.hasExtensionSources) {
        return Promise.resolve(emptyEventEmissionResult(name));
      }
      return engine.emitEvent(name, event);
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

    for (const diagnostic of nextRegistry.diagnostics) {
      if (diagnostic.phase !== "command.override") continue;
      debugLog("extensions", "%s", diagnostic.error.message);
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
    events,
    getBackend,
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
