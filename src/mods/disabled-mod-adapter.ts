import { clearRegisteredPiProviders } from "@/backend/dev/pi-provider-mod-registry";
import {
  cloneModCapabilities,
  DISABLED_MOD_CAPABILITIES,
} from "@/mods/capabilities";
import { emptyEventEmissionResult, type ModEvents } from "@/mods/event-emitter";
import type { LocalModRegistry, ModEngine } from "@/mods/mod-engine";
import { clearModPermissions } from "@/mods/permission-registry";
import { clearModTools } from "@/mods/tool-registry";

function createDisabledModRegistry(): LocalModRegistry {
  return {
    capabilities: cloneModCapabilities(DISABLED_MOD_CAPABILITIES),
    commands: {},
    diagnostics: [],
    disposers: [],
    events: {},
    generation: 0,
    loadedPaths: [],
    ownerAbortControllers: {},
    owners: {},
    permissions: {},
    registerCapabilitiesGlobally: false,
    sources: [],
    tools: {},
    ui: {
      panels: {},
    },
  };
}

function createDisabledModEngine(registry: LocalModRegistry): ModEngine {
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

export function createDisabledModAdapter() {
  clearModPermissions();
  clearModTools();
  clearRegisteredPiProviders();

  const registry = createDisabledModRegistry();
  const engine = createDisabledModEngine(registry);
  const snapshot = {
    hadModPanels: false,
    hasModSources: false,
    isLoading: false,
    registry,
  };
  const events: ModEvents = {
    emit(name) {
      return Promise.resolve(emptyEventEmissionResult(name));
    },
  };

  return {
    dispose() {},
    events,
    getAvailablePermissions() {
      return new Map();
    },
    getAvailableTools() {
      return new Map();
    },
    getBackend() {
      return undefined;
    },
    getSnapshot() {
      return snapshot;
    },
    engine,
    reload() {
      return Promise.resolve();
    },
    subscribe(_listener: () => void) {
      return () => undefined;
    },
  };
}
