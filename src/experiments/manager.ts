import { settingsManager } from "../settings-manager";
import type {
  ExperimentDefinition,
  ExperimentId,
  ExperimentSnapshot,
} from "./types";

const ENABLED_TOGGLE_VALUES = new Set(["1", "true", "yes"]);

const EXPERIMENT_DEFINITIONS: readonly ExperimentDefinition[] = [
  {
    id: "node",
    label: "node",
    description: "Route API requests through the Letta Node / TS core path.",
    envVar: "LETTA_NODE",
  },
] as const;

function isEnabledToggle(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ENABLED_TOGGLE_VALUES.has(value.trim().toLowerCase());
}

function getExperimentDefinition(id: ExperimentId): ExperimentDefinition {
  const definition = EXPERIMENT_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) {
    throw new Error(`Unknown experiment: ${id}`);
  }
  return definition;
}

class ExperimentManager {
  private getStoredOverrides(): Partial<Record<ExperimentId, boolean>> {
    try {
      return settingsManager.getSettings().experiments ?? {};
    } catch {
      return {};
    }
  }

  list(): ExperimentSnapshot[] {
    return EXPERIMENT_DEFINITIONS.map((definition) =>
      this.getSnapshot(definition.id),
    );
  }

  getSnapshot(id: ExperimentId): ExperimentSnapshot {
    const definition = getExperimentDefinition(id);
    const override = this.getStoredOverrides()[id];

    if (typeof override === "boolean") {
      return {
        ...definition,
        enabled: override,
        source: "override",
        override,
      };
    }

    const envEnabled = definition.envVar
      ? isEnabledToggle(process.env[definition.envVar])
      : false;

    return {
      ...definition,
      enabled: envEnabled,
      source: envEnabled ? "env" : "default",
      override: null,
    };
  }

  isEnabled(id: ExperimentId): boolean {
    return this.getSnapshot(id).enabled;
  }

  set(id: ExperimentId, enabled: boolean): ExperimentSnapshot {
    const settings = settingsManager.getSettings();
    settingsManager.updateSettings({
      experiments: {
        ...(settings.experiments ?? {}),
        [id]: enabled,
      },
    });
    return this.getSnapshot(id);
  }

  toggle(id: ExperimentId): ExperimentSnapshot {
    const snapshot = this.getSnapshot(id);
    return this.set(id, !snapshot.enabled);
  }
}

export const experimentManager = new ExperimentManager();
