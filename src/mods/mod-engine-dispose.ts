import { clearAvailableModelsCache } from "@/agent/available-models";
import { unregisterPiProvidersForOwner } from "@/backend/dev/pi-provider-mod-registry";
import { recordModDiagnostic } from "@/mods/mod-diagnostics";
import type { LocalModRegistry } from "@/mods/mod-engine";
import { unregisterProcessGlobalCapabilitiesFromLocalRegistry } from "@/mods/process-global-teardown";

export function disposeLocalMods(registry: LocalModRegistry): void {
  for (const abortController of Object.values(registry.ownerAbortControllers)) {
    abortController.abort("mod disposed");
  }

  const disposers = [...registry.disposers].reverse();
  registry.disposers = [];

  for (const { dispose, owner } of disposers) {
    try {
      dispose();
    } catch (error) {
      recordModDiagnostic(registry, {
        error: error instanceof Error ? error : new Error(String(error)),
        owner,
        phase: "dispose",
      });
    }
  }

  if (registry.registerCapabilitiesGlobally) {
    unregisterProcessGlobalCapabilitiesFromLocalRegistry(
      registry.tools,
      registry.permissions,
    );
    for (const owner of Object.values(registry.owners)) {
      unregisterPiProvidersForOwner(owner.id);
    }
    clearAvailableModelsCache();
  }

  registry.commands = {};
  registry.events = {};
  registry.ownerAbortControllers = {};
  registry.owners = {};
  registry.permissions = {};
  registry.tools = {};
  registry.ui.panels = {};
}
