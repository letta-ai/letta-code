import type { Backend } from "@/backend";
import { areModsDisabled, disableModsForProcess } from "@/mods/disable";
import { createDisabledModAdapter } from "@/mods/disabled-mod-adapter";
import { emptyEventEmissionResult, type ModEvents } from "@/mods/event-emitter";
import { getModErrorDiagnostics } from "@/mods/mod-diagnostics";
import { writeModDiagnosticsLatestFile } from "@/mods/mod-diagnostics-file";
import {
  type CreateModEngineOptions,
  createModEngine,
  type ModEngine,
  type ResolveLocalModSourcesOptions,
  resolveLocalModSources,
} from "@/mods/mod-engine";
import {
  filterAvailableModPermissionsRegistry,
  type ModPermissionDefinition,
} from "@/mods/permission-registry";
import {
  filterAvailableModToolsRegistry,
  type ModToolDefinition,
} from "@/mods/tool-registry";
import type { ModContext } from "@/mods/types";
import { debugLog } from "@/utils/debug";

const RUNTIME_DIAGNOSTICS_WRITE_DELAY_MS = 30_000;

export interface ModAdapterLoadState {
  hadModPanels: boolean;
  hasModSources: boolean;
  isLoading: boolean;
}

export interface ModAdapterSnapshot extends ModAdapterLoadState {
  registry: ReturnType<ModEngine["getSnapshot"]>;
}

export interface CreateModAdapterOptions extends CreateModEngineOptions {
  diagnosticsRootDirectory?: string;
  diagnosticsWriteDelayMs?: number;
  disabled?: boolean;
}

export interface ModAdapter {
  dispose: () => void;
  events: ModEvents;
  getAvailablePermissions: (
    context?: ModContext | null,
  ) => Map<string, ModPermissionDefinition>;
  getAvailableTools: (
    context?: ModContext | null,
  ) => Map<string, ModToolDefinition>;
  getBackend: () => Backend | undefined;
  getSnapshot: () => ModAdapterSnapshot;
  engine: ModEngine;
  reload: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
}

function hasModSources(options: ResolveLocalModSourcesOptions): boolean {
  return resolveLocalModSources(options).some(
    (source) => source.files.length > 0,
  );
}

export function createModAdapter(options: CreateModAdapterOptions): ModAdapter {
  const {
    diagnosticsRootDirectory,
    diagnosticsWriteDelayMs = RUNTIME_DIAGNOSTICS_WRITE_DELAY_MS,
    disabled,
    getBackend: resolveBackend,
    ...engineOptions
  } = options;

  const alreadyDisabled = areModsDisabled();
  if (disabled || alreadyDisabled) {
    if (!alreadyDisabled) {
      disableModsForProcess();
    }
    return createDisabledModAdapter();
  }

  let disposed = false;
  const initialHasModSources = hasModSources(engineOptions);
  let loadState: ModAdapterLoadState = {
    hadModPanels: false,
    hasModSources: initialHasModSources,
    isLoading: initialHasModSources,
  };
  const listeners = new Set<() => void>();
  let diagnosticsWriteTimer: ReturnType<typeof setTimeout> | null = null;

  const getBackend = () => resolveBackend?.();

  const engine = createModEngine({
    ...engineOptions,
    getBackend,
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
      writeModDiagnosticsLatestFile(registry.diagnostics, {
        rootDirectory: diagnosticsRootDirectory,
      });
    } catch (error) {
      debugLog(
        "mods",
        "failed to write mod diagnostics: %s",
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
    if (disposed || loadState.isLoading || !loadState.hasModSources) return;
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

  const events: ModEvents = {
    async emit(name, event, scopedContext) {
      if (loadState.isLoading || !loadState.hasModSources) {
        // Events are best-effort hooks; do not deliver them while the mod
        // registry is unavailable or in flux.
        return emptyEventEmissionResult(name);
      }
      const result = await engine.emitEvent(name, event, scopedContext);
      return result;
    },
  };

  const buildSnapshot = (): ModAdapterSnapshot => ({
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
    const previousHadModPanels =
      Object.keys(previousSnapshot.ui.panels).length > 0 ||
      loadState.hadModPanels;
    loadState = {
      hadModPanels: previousHadModPanels,
      hasModSources: hasModSources(engineOptions),
      isLoading: true,
    };
    publish();

    await engine.reload();
    if (disposed) return;

    const nextRegistry = engine.getSnapshot();
    writeLatestDiagnostics();

    debugLog(
      "mods",
      "loaded %s mod(s) from %s source(s); panels=%s",
      nextRegistry.loadedPaths.length,
      nextRegistry.sources.length,
      Object.keys(nextRegistry.ui.panels).length,
    );

    for (const diagnostic of getModErrorDiagnostics(nextRegistry.diagnostics)) {
      debugLog(
        "mods",
        "failed to load %s: %s",
        diagnostic.owner.path,
        diagnostic.error.message,
      );
    }

    for (const diagnostic of nextRegistry.diagnostics) {
      if (diagnostic.phase === "command_override") {
        debugLog("mods", "%s", diagnostic.error.message);
      }
    }

    loadState = {
      hadModPanels: Object.keys(nextRegistry.ui.panels).length > 0,
      hasModSources: nextRegistry.sources.some(
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
    getAvailablePermissions(context) {
      return filterAvailableModPermissionsRegistry(
        new Map(Object.entries(engine.getSnapshot().permissions)),
        context,
      );
    },
    getAvailableTools(context) {
      return filterAvailableModToolsRegistry(
        new Map(Object.entries(engine.getSnapshot().tools)),
        context,
      );
    },
    getBackend,
    getSnapshot,
    engine,
    reload,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
