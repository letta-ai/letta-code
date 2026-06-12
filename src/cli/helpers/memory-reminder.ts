// Reflection (sleep-time) trigger settings: resolution, persistence, and
// step-count trigger evaluation.

import { settingsManager } from "@/settings-manager";

const DEFAULT_STEP_COUNT = 25;

export type MemoryReminderMode =
  | number
  | null
  | "compaction"
  | "auto-compaction";

export type ReflectionTrigger = "off" | "step-count" | "compaction-event";

export interface ReflectionSettings {
  trigger: ReflectionTrigger;
  stepCount: number;
}

type PersistedReflectionSettings = {
  trigger?: unknown;
  stepCount?: unknown;
};

interface ReflectionSettingsCarrier {
  memoryReminderInterval?: MemoryReminderMode;
  reflectionTrigger?: unknown;
  reflectionStepCount?: unknown;
  reflectionSettingsByAgent?: Record<string, PersistedReflectionSettings>;
}

const DEFAULT_REFLECTION_SETTINGS: ReflectionSettings = {
  trigger: "compaction-event",
  stepCount: DEFAULT_STEP_COUNT,
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

function applyExplicitReflectionOverrides(
  base: ReflectionSettings,
  raw: {
    reflectionTrigger?: unknown;
    reflectionStepCount?: unknown;
  },
): ReflectionSettings {
  return {
    trigger: normalizeTrigger(raw.reflectionTrigger, base.trigger),
    stepCount: normalizeStepCount(raw.reflectionStepCount, base.stepCount),
  };
}

function applyPersistedAgentScopedSettings(
  base: ReflectionSettings,
  raw: PersistedReflectionSettings | undefined,
): ReflectionSettings {
  if (!raw) {
    return base;
  }

  return {
    trigger: normalizeTrigger(raw.trigger, base.trigger),
    stepCount: normalizeStepCount(raw.stepCount, base.stepCount),
  };
}

function legacyModeToReflectionSettings(
  mode: MemoryReminderMode | undefined,
): ReflectionSettings {
  if (typeof mode === "number") {
    return {
      trigger: "step-count",
      stepCount: normalizeStepCount(mode, DEFAULT_STEP_COUNT),
    };
  }

  if (mode === null) {
    return {
      trigger: "off",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
    };
  }

  if (mode === "compaction") {
    return {
      trigger: "compaction-event",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
    };
  }

  if (mode === "auto-compaction") {
    return {
      trigger: "compaction-event",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
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
): ReflectionSettings {
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

  if (agentId) {
    const localScoped = localSettings?.reflectionSettingsByAgent?.[agentId];
    if (localScoped) {
      return applyPersistedAgentScopedSettings(
        DEFAULT_REFLECTION_SETTINGS,
        localScoped,
      );
    }

    const globalScoped = globalSettings.reflectionSettingsByAgent?.[agentId];
    if (globalScoped) {
      return applyPersistedAgentScopedSettings(
        DEFAULT_REFLECTION_SETTINGS,
        globalScoped,
      );
    }
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
        reflectionSettingsByAgent: {
          ...(localSettings.reflectionSettingsByAgent ?? {}),
          [agentId]: {
            trigger: settings.trigger,
            stepCount: settings.stepCount,
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
      reflectionSettingsByAgent: {
        ...(globalSettings.reflectionSettingsByAgent ?? {}),
        [agentId]: {
          trigger: settings.trigger,
          stepCount: settings.stepCount,
        },
      },
    });
  }
}
