import {
  getConversationTitleSettings,
  setConversationTitleSettings,
} from "@/cli/helpers/conversation-title";
import { settingsManager } from "@/settings-manager";
import type {
  ExperimentDefinition,
  ExperimentId,
  ExperimentSnapshot,
} from "./types";

const ENABLED_TOGGLE_VALUES = new Set(["1", "true", "yes"]);

const EXPERIMENT_DEFINITIONS: readonly ExperimentDefinition[] = [
  {
    id: "artifacts",
    label: "artifacts",
    description:
      "Expose Letta Code Desktop artifact creation tools and artifact UI surfaces.",
    envVar: "LETTA_ARTIFACTS",
  },
  {
    id: "conversation_titles",
    label: "conversation titles",
    description: "Generate AI conversation titles automatically when possible.",
  },
  {
    id: "desktop_conversation_bootstrap",
    label: "conversation bootstrap",
    description:
      "Inject lightweight prior-conversation context into the first turn of brand-new Letta Code conversations.",
  },
  {
    id: "diffs",
    label: "diffs",
    description:
      "Open browser-based worktree diff previews powered by Diffs from Pierre.",
  },
  {
    id: "node",
    label: "node",
    description: "Route API requests through the Letta Node / TS core path.",
    envVar: "LETTA_NODE",
  },
  {
    id: "reflection_arena",
    label: "reflection arena",
    description:
      "Run blind A/B comparisons between reflection models on the same transcript sample.",
    envVar: "LETTA_REFLECTION_ARENA",
  },
  {
    id: "tui_cron",
    label: "TUI cron scheduler",
    description:
      "Fire scheduled tasks from the CLI when the desktop app isn't running.",
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

    if (id === "conversation_titles") {
      return {
        ...definition,
        enabled: getConversationTitleSettings().enabled,
        source: "default",
        override: null,
      };
    }

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
    if (id === "conversation_titles") {
      setConversationTitleSettings(enabled);
      return this.getSnapshot(id);
    }

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
