// Reflection (sleep-time) settings: resolution, persistence, merge policy,
// and step-count trigger evaluation.

import type {
  ReflectionMergeMode,
  ReflectionTrigger,
} from "@/reflection-settings";
import { settingsManager } from "@/settings-manager";

export type {
  ReflectionMergeMode,
  ReflectionTrigger,
} from "@/reflection-settings";

const DEFAULT_STEP_COUNT = 25;

export type MemoryReminderMode =
  | number
  | null
  | "compaction"
  | "auto-compaction";

export interface ReflectionSettings {
  trigger: ReflectionTrigger;
  stepCount: number;
  merge?: ReflectionMergeMode;
  mergeInstructions?: string;
}

export interface ResolvedReflectionSettings extends ReflectionSettings {
  merge: ReflectionMergeMode;
  mergeInstructions: string;
}

type PersistedReflectionSettings = {
  trigger?: unknown;
  stepCount?: unknown;
  merge?: unknown;
  mergeInstructions?: unknown;
};

interface ReflectionSettingsCarrier {
  memoryReminderInterval?: MemoryReminderMode;
  reflectionTrigger?: unknown;
  reflectionStepCount?: unknown;
  reflectionMerge?: unknown;
  reflectionMergeInstructions?: unknown;
  reflectionSettingsByAgent?: Record<string, PersistedReflectionSettings>;
}

const DEFAULT_REFLECTION_SETTINGS: ResolvedReflectionSettings = {
  trigger: "compaction-event",
  stepCount: DEFAULT_STEP_COUNT,
  merge: "auto",
  mergeInstructions: "",
};

function isValidStepCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

function normalizeStepCount(value: unknown, fallback: number): number {
  return isValidStepCount(value) ? value : fallback;
}

function normalizeTrigger(
  value: unknown,
  fallback: ReflectionTrigger,
): ReflectionTrigger {
  if (
    value === "off" ||
    value === "step-count" ||
    value === "compaction-event"
  ) {
    return value;
  }
  return fallback;
}

function normalizeMerge(
  value: unknown,
  fallback: ReflectionMergeMode,
): ReflectionMergeMode {
  return value === "auto" || value === "explicit" ? value : fallback;
}

function normalizeMergeInstructions(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function applyExplicitReflectionOverrides(
  base: ResolvedReflectionSettings,
  raw: {
    reflectionTrigger?: unknown;
    reflectionStepCount?: unknown;
    reflectionMerge?: unknown;
    reflectionMergeInstructions?: unknown;
  },
): ResolvedReflectionSettings {
  return {
    trigger: normalizeTrigger(raw.reflectionTrigger, base.trigger),
    stepCount: normalizeStepCount(raw.reflectionStepCount, base.stepCount),
    merge: normalizeMerge(raw.reflectionMerge, base.merge),
    mergeInstructions: normalizeMergeInstructions(
      raw.reflectionMergeInstructions,
      base.mergeInstructions,
    ),
  };
}

function applyPersistedAgentScopedSettings(
  base: ResolvedReflectionSettings,
  raw: PersistedReflectionSettings | undefined,
): ResolvedReflectionSettings {
  if (!raw) {
    return base;
  }

  return {
    trigger: normalizeTrigger(raw.trigger, base.trigger),
    stepCount: normalizeStepCount(raw.stepCount, base.stepCount),
    merge: normalizeMerge(raw.merge, base.merge),
    mergeInstructions: normalizeMergeInstructions(
      raw.mergeInstructions,
      base.mergeInstructions,
    ),
  };
}

function legacyModeToReflectionSettings(
  mode: MemoryReminderMode | undefined,
): ResolvedReflectionSettings {
  if (typeof mode === "number") {
    return {
      trigger: "step-count",
      stepCount: normalizeStepCount(mode, DEFAULT_STEP_COUNT),
      merge: DEFAULT_REFLECTION_SETTINGS.merge,
      mergeInstructions: DEFAULT_REFLECTION_SETTINGS.mergeInstructions,
    };
  }

  if (mode === null) {
    return {
      trigger: "off",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
      merge: DEFAULT_REFLECTION_SETTINGS.merge,
      mergeInstructions: DEFAULT_REFLECTION_SETTINGS.mergeInstructions,
    };
  }

  if (mode === "compaction") {
    return {
      trigger: "compaction-event",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
      merge: DEFAULT_REFLECTION_SETTINGS.merge,
      mergeInstructions: DEFAULT_REFLECTION_SETTINGS.mergeInstructions,
    };
  }

  if (mode === "auto-compaction") {
    return {
      trigger: "compaction-event",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
      merge: DEFAULT_REFLECTION_SETTINGS.merge,
      mergeInstructions: DEFAULT_REFLECTION_SETTINGS.mergeInstructions,
    };
  }

  return { ...DEFAULT_REFLECTION_SETTINGS };
}

export function reflectionSettingsToLegacyMode(
  settings: ReflectionSettings,
): MemoryReminderMode {
  if (settings.trigger === "off") {
    return null;
  }
  if (settings.trigger === "compaction-event") {
    return "auto-compaction";
  }
  return normalizeStepCount(settings.stepCount, DEFAULT_STEP_COUNT);
}

/**
 * Get effective reflection settings (local overrides global with legacy fallback).
 */
export function getReflectionSettings(
  agentId?: string,
  workingDirectory: string = process.cwd(),
): ResolvedReflectionSettings {
  const globalSettings =
    settingsManager.getSettings() as unknown as ReflectionSettingsCarrier;
  let localSettings: ReflectionSettingsCarrier | null = null;

  try {
    localSettings = settingsManager.getLocalProjectSettings(
      workingDirectory,
    ) as unknown as ReflectionSettingsCarrier;
  } catch {
    localSettings = null;
  }

  let resolved = legacyModeToReflectionSettings(
    globalSettings.memoryReminderInterval,
  );
  resolved = applyExplicitReflectionOverrides(resolved, globalSettings);

  if (localSettings) {
    if (localSettings.memoryReminderInterval !== undefined) {
      resolved = legacyModeToReflectionSettings(
        localSettings.memoryReminderInterval,
      );
    }
    resolved = applyExplicitReflectionOverrides(resolved, localSettings);
  }

  if (agentId) {
    resolved = applyPersistedAgentScopedSettings(
      resolved,
      globalSettings.reflectionSettingsByAgent?.[agentId],
    );
    resolved = applyPersistedAgentScopedSettings(
      resolved,
      localSettings?.reflectionSettingsByAgent?.[agentId],
    );
  }

  return resolved;
}

export function shouldFireStepCountTrigger(
  stepsSinceLastSuccessfulReflection: number,
  settings: ReflectionSettings = getReflectionSettings(),
): boolean {
  if (settings.trigger !== "step-count") {
    return false;
  }
  const stepCount = normalizeStepCount(settings.stepCount, DEFAULT_STEP_COUNT);
  return stepsSinceLastSuccessfulReflection >= stepCount;
}

type PersistReflectionSettingsOptions = {
  workingDirectory?: string;
  persistLocalProject?: boolean;
  persistGlobal?: boolean;
};

export async function persistReflectionSettingsForAgent(
  agentId: string,
  settings: ReflectionSettings,
  options: PersistReflectionSettingsOptions = {},
): Promise<void> {
  const {
    workingDirectory = process.cwd(),
    persistLocalProject = true,
    persistGlobal = true,
  } = options;
  const merge = normalizeMerge(
    settings.merge,
    DEFAULT_REFLECTION_SETTINGS.merge,
  );
  const mergeInstructions = normalizeMergeInstructions(
    settings.mergeInstructions,
    DEFAULT_REFLECTION_SETTINGS.mergeInstructions,
  );
  const legacyMode = reflectionSettingsToLegacyMode(settings);

  if (persistLocalProject) {
    try {
      settingsManager.getLocalProjectSettings(workingDirectory);
    } catch {
      await settingsManager.loadLocalProjectSettings(workingDirectory);
    }

    const localSettings =
      settingsManager.getLocalProjectSettings(workingDirectory);
    settingsManager.updateLocalProjectSettings(
      {
        memoryReminderInterval: legacyMode,
        reflectionTrigger: settings.trigger,
        reflectionStepCount: settings.stepCount,
        reflectionMerge: merge,
        reflectionMergeInstructions: mergeInstructions,
        reflectionSettingsByAgent: {
          ...(localSettings.reflectionSettingsByAgent ?? {}),
          [agentId]: {
            trigger: settings.trigger,
            stepCount: settings.stepCount,
            merge,
            mergeInstructions,
          },
        },
      },
      workingDirectory,
    );
  }

  if (persistGlobal) {
    const globalSettings = settingsManager.getSettings();
    settingsManager.updateSettings({
      memoryReminderInterval: legacyMode,
      reflectionTrigger: settings.trigger,
      reflectionStepCount: settings.stepCount,
      reflectionMerge: merge,
      reflectionMergeInstructions: mergeInstructions,
      reflectionSettingsByAgent: {
        ...(globalSettings.reflectionSettingsByAgent ?? {}),
        [agentId]: {
          trigger: settings.trigger,
          stepCount: settings.stepCount,
          merge,
          mergeInstructions,
        },
      },
    });
  }
}
