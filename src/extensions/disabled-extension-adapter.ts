import { clearRegisteredPiProviders } from "@/backend/dev/pi-provider-extension-registry";
import {
  cloneExtensionCapabilities,
  DISABLED_EXTENSION_CAPABILITIES,
} from "@/extensions/capabilities";
import {
  type ExtensionEvents,
  emptyEventEmissionResult,
} from "@/extensions/event-emitter";
import { writeExtensionDiagnosticsLatestFile } from "@/extensions/extension-diagnostics-file";
import type {
  ExtensionEngine,
  LocalExtensionRegistry,
} from "@/extensions/extension-engine";
import { clearExtensionTools } from "@/extensions/tool-registry";
import type { ExtensionContext } from "@/extensions/types";
import { debugLog } from "@/utils/debug";

interface CreateDisabledExtensionAdapterOptions {
  diagnosticsRootDirectory?: string;
  initialContext: ExtensionContext;
}

function writeEmptyDiagnosticsLatestFile(rootDirectory?: string): void {
  try {
    writeExtensionDiagnosticsLatestFile([], { rootDirectory });
  } catch (error) {
    debugLog(
      "extensions",
      "failed to write extension diagnostics: %s",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function createDisabledExtensionRegistry(): LocalExtensionRegistry {
  return {
    capabilities: cloneExtensionCapabilities(DISABLED_EXTENSION_CAPABILITIES),
    commands: {},
    diagnostics: [],
    disposers: [],
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
    subscribe(_listener: () => void) {
      return () => undefined;
    },
  };
}

export function createDisabledExtensionAdapter(
  options: CreateDisabledExtensionAdapterOptions,
) {
  clearExtensionTools();
  clearRegisteredPiProviders();

  let context = options.initialContext;
  const registry = createDisabledExtensionRegistry();
  const engine = createDisabledExtensionEngine(registry);
  const snapshot = {
    hadStatuslineRenderer: false,
    hasExtensionSources: false,
    isLoading: false,
    registry,
  };
  const events: ExtensionEvents = {
    emit(name) {
      return Promise.resolve(emptyEventEmissionResult(name));
    },
  };

  return {
    dispose() {},
    events,
    getBackend() {
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
      writeEmptyDiagnosticsLatestFile(options.diagnosticsRootDirectory);
      return Promise.resolve();
    },
    subscribe(_listener: () => void) {
      return () => undefined;
    },
    updateContext(nextContext: ExtensionContext) {
      context = nextContext;
    },
  };
}
