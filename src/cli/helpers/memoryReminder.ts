// src/cli/helpers/memoryReminder.ts
// Handles periodic memory reminder logic and preference parsing

import { settingsManager } from "../../settings-manager";
import { debugLog } from "../../utils/debug";

// Memory reminder interval presets
const MEMORY_INTERVAL_FREQUENT = 5;
const MEMORY_INTERVAL_OCCASIONAL = 10;
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

/**
 * Legacy mode view used by existing call sites while migrating to split fields.
 */
export function getMemoryReminderMode(
  agentId?: string,
  workingDirectory?: string,
): MemoryReminderMode {
  return reflectionSettingsToLegacyMode(
    getReflectionSettings(agentId, workingDirectory),
  );
}

export function shouldFireStepCountTrigger(
  turnCount: number,
  settings: ReflectionSettings = getReflectionSettings(),
): boolean {
  if (settings.trigger !== "step-count") {
    return false;
  }
  const stepCount = normalizeStepCount(settings.stepCount, DEFAULT_STEP_COUNT);
  return turnCount > 0 && turnCount % stepCount === 0;
}

async function buildMemfsAwareMemoryReminder(
  agentId: string,
  trigger: "interval" | "compaction",
): Promise<string> {
  debugLog(
    "memory",
    `${settingsManager.isMemfsEnabled(agentId) ? "Memfs" : "Memory"} check reminder fired (${trigger}, agent ${agentId})`,
  );
  const { MEMORY_CHECK_REMINDER } = await import("../../agent/promptAssets.js");
  return MEMORY_CHECK_REMINDER;
}

/**
 * Build a compaction-triggered memory reminder. Uses the same memfs-aware
 * selection as interval reminders.
 */
export async function buildCompactionMemoryReminder(
  agentId: string,
): Promise<string> {
  return buildMemfsAwareMemoryReminder(agentId, "compaction");
}

/**
 * Build a memory check reminder if the turn count matches the interval.
 *
 * Returns MEMORY_CHECK_REMINDER when the interval trigger fires.
 * Reflection subagent launch is handled by runtime orchestration, not reminder text.
 *
 * @param turnCount - Current conversation turn count
 * @param agentId - Current agent ID (needed to check MemFS status)
 * @returns Promise resolving to the reminder string (empty if not applicable)
 */
export async function buildMemoryReminder(
  turnCount: number,
  agentId: string,
  workingDirectory?: string,
): Promise<string> {
  const reflectionSettings = getReflectionSettings(agentId, workingDirectory);
  if (reflectionSettings.trigger !== "step-count") {
    return "";
  }

  if (shouldFireStepCountTrigger(turnCount, reflectionSettings)) {
    debugLog(
      "memory",
      `Turn-based memory reminder fired (turn ${turnCount}, interval ${reflectionSettings.stepCount}, agent ${agentId})`,
    );
    return buildMemfsAwareMemoryReminder(agentId, "interval");
  }

  return "";
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

interface Question {
  question: string;
  header?: string;
}

/**
 * Parse user's answer to a memory preference question and update settings
 * @param questions - Array of questions that were asked
 * @param answers - Record of question -> answer
 * @returns true if a memory preference was detected and setting was updated
 */
export function parseMemoryPreference(
  questions: Question[],
  answers: Record<string, string>,
  agentId?: string,
  workingDirectory?: string,
): boolean {
  for (const q of questions) {
    // Skip malformed questions (LLM might send invalid data)
    if (!q.question) continue;
    const questionLower = q.question.toLowerCase();
    const headerLower = q.header?.toLowerCase() || "";

    // Match memory-related questions
    if (
      questionLower.includes("memory") ||
      questionLower.includes("remember") ||
      headerLower.includes("memory")
    ) {
      const answer = answers[q.question]?.toLowerCase() || "";

      // Parse answer: "frequent" → MEMORY_INTERVAL_FREQUENT, "occasional" → MEMORY_INTERVAL_OCCASIONAL
      if (answer.includes("frequent")) {
        if (agentId) {
          void persistReflectionSettingsForAgent(
            agentId,
            {
              trigger: "step-count",
              stepCount: MEMORY_INTERVAL_FREQUENT,
            },
            {
              workingDirectory,
              persistLocalProject: true,
              persistGlobal: false,
            },
          );
        } else {
          settingsManager.updateLocalProjectSettings(
            {
              memoryReminderInterval: MEMORY_INTERVAL_FREQUENT,
              reflectionTrigger: "step-count",
              reflectionStepCount: MEMORY_INTERVAL_FREQUENT,
            },
            workingDirectory,
          );
        }
        return true;
      } else if (answer.includes("occasional")) {
        if (agentId) {
          void persistReflectionSettingsForAgent(
            agentId,
            {
              trigger: "step-count",
              stepCount: MEMORY_INTERVAL_OCCASIONAL,
            },
            {
              workingDirectory,
              persistLocalProject: true,
              persistGlobal: false,
            },
          );
        } else {
          settingsManager.updateLocalProjectSettings(
            {
              memoryReminderInterval: MEMORY_INTERVAL_OCCASIONAL,
              reflectionTrigger: "step-count",
              reflectionStepCount: MEMORY_INTERVAL_OCCASIONAL,
            },
            workingDirectory,
          );
        }
        return true;
      }
      break; // Only process first matching question
    }
  }
  return false;
}
