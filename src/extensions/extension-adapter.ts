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
import { getExtensionErrorDiagnostics } from "@/extensions/extension-diagnostics";
import { writeExtensionDiagnosticsLatestFile } from "@/extensions/extension-diagnostics-file";
import {
  type CreateExtensionEngineOptions,
  createExtensionEngine,
  type ExtensionEngine,
  type ResolveLocalExtensionSourcesOptions,
  resolveLocalExtensionSources,
} from "@/extensions/extension-engine";
import type { ExtensionContext } from "@/extensions/types";
import { debugLog } from "@/utils/debug";

const RUNTIME_DIAGNOSTICS_WRITE_DELAY_MS = 30_000;

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
  diagnosticsRootDirectory?: string;
  diagnosticsWriteDelayMs?: number;
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
  options: ResolveLocalExtensionSourcesOptions,
): boolean {
  return resolveLocalExtensionSources(options).some(
    (source) => source.files.length > 0,
  );
}

export function createExtensionAdapter(
  options: CreateExtensionAdapterOptions,
): ExtensionAdapter {
  const {
    diagnosticsRootDirectory,
    diagnosticsWriteDelayMs = RUNTIME_DIAGNOSTICS_WRITE_DELAY_MS,
    disabled,
    getBackend: resolveBackend,
    initialContext,
    ...engineOptions
  } = options;

  if (disabled) {
    disableExtensionsForProcess();
    return createDisabledExtensionAdapter({ initialContext });
  }

  if (areExtensionsDisabled()) {
    return createDisabledExtensionAdapter({ initialContext });
  }

  let context = initialContext;
  let disposed = false;
  const initialHasExtensionSources = hasExtensionSources(engineOptions);
  let loadState: ExtensionAdapterLoadState = {
    hadStatuslineRenderer: false,
    hasExtensionSources: initialHasExtensionSources,
    isLoading: initialHasExtensionSources,
  };
  const listeners = new Set<() => void>();
  let diagnosticsWriteTimer: ReturnType<typeof setTimeout> | null = null;

  const getBackend = () => resolveBackend?.();
  const getContext = () => context;

  const engine = createExtensionEngine({
    ...engineOptions,
    getBackend,
    getContext,
    onDiagnostic: () => scheduleDiagnosticsWrite(),
  });

  function clearPendingDiagnosticsWrite(): void {
    if (!diagnosticsWriteTimer) return;
    clearTimeout(diagnosticsWriteTimer);
    diagnosticsWriteTimer = null;
  }

  function writeLatestDiagnostics(): void {
    const registry = engine.getSnapshot();
    if (!registry.sources.some((source) => source.files.length > 0)) return;

    try {
      writeExtensionDiagnosticsLatestFile(registry.diagnostics, {
        rootDirectory: diagnosticsRootDirectory,
      });
    } catch (error) {
      debugLog(
        "extensions",
        "failed to write extension diagnostics: %s",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function flushPendingDiagnosticsWrite(): void {
    if (!diagnosticsWriteTimer) return;
    clearPendingDiagnosticsWrite();
    writeLatestDiagnostics();
  }

  function scheduleDiagnosticsWrite(): void {
    if (disposed || loadState.isLoading || !loadState.hasExtensionSources)
      return;
    if (diagnosticsWriteTimer) return;

    diagnosticsWriteTimer = setTimeout(() => {
      diagnosticsWriteTimer = null;
      writeLatestDiagnostics();
    }, diagnosticsWriteDelayMs);
    const timerWithUnref = diagnosticsWriteTimer as ReturnType<
      typeof setTimeout
    > & { unref?: () => void };
    timerWithUnref.unref?.();
  }

  const events: ExtensionEvents = {
    async emit(name, event) {
      if (loadState.isLoading || !loadState.hasExtensionSources) {
        // Events are best-effort hooks; do not deliver them while the extension
        // registry is unavailable or in flux.
        return emptyEventEmissionResult(name);
      }
      const result = await engine.emitEvent(name, event);
      return result;
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
    clearPendingDiagnosticsWrite();

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
    writeLatestDiagnostics();

    debugLog(
      "extensions",
      "loaded %s extension(s) from %s source(s); renderer=%s",
      nextRegistry.loadedPaths.length,
      nextRegistry.sources.length,
      nextRegistry.ui.statuslineRenderer?.id ?? "(none)",
    );

    for (const diagnostic of getExtensionErrorDiagnostics(
      nextRegistry.diagnostics,
    )) {
      debugLog(
        "extensions",
        "failed to load %s: %s",
        diagnostic.owner.path,
        diagnostic.error.message,
      );
    }

    for (const diagnostic of nextRegistry.diagnostics) {
      if (diagnostic.phase === "command_override") {
        debugLog("extensions", "%s", diagnostic.error.message);
      }
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
      flushPendingDiagnosticsWrite();
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
