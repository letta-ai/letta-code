// src/cli/helpers/memoryReminder.ts
// Handles periodic memory reminder logic and preference parsing

import { settingsManager } from "../../settings-manager";
import { debugLog } from "../../utils/debug";

// Memory reminder interval presets
const MEMORY_INTERVAL_FREQUENT = 5;
const MEMORY_INTERVAL_OCCASIONAL = 10;
const DEFAULT_STEP_COUNT = 25;
const DEFAULT_IDLE_SWEEP_INTERVAL_HOURS = 24;
const DEFAULT_IDLE_CONVERSATION_MIN_AGE_HOURS = 24;
const DEFAULT_IDLE_MIN_UNREFLECTED_TURNS = 3;

export type MemoryReminderMode =
  | number
  | null
  | "compaction"
  | "auto-compaction";

export type ReflectionTrigger = "off" | "step-count" | "compaction-event";

export interface ReflectionSettings {
  /** Back-compat alias for activeTrigger. */
  trigger: ReflectionTrigger;
  /** Back-compat alias for activeStepCount. */
  stepCount: number;
  activeTrigger?: ReflectionTrigger;
  activeStepCount?: number;
  idleSweepEnabled?: boolean;
  idleSweepIntervalHours?: number;
  idleConversationMinAgeHours?: number;
  idleMinUnreflectedTurns?: number;
}

export type NormalizedReflectionSettings = Required<ReflectionSettings>;

type PersistedReflectionSettings = {
  trigger?: unknown;
  stepCount?: unknown;
  activeTrigger?: unknown;
  activeStepCount?: unknown;
  idleSweepEnabled?: unknown;
  idleSweepIntervalHours?: unknown;
  idleConversationMinAgeHours?: unknown;
  idleMinUnreflectedTurns?: unknown;
};

interface ReflectionSettingsCarrier {
  memoryReminderInterval?: MemoryReminderMode;
  reflectionTrigger?: unknown;
  reflectionStepCount?: unknown;
  reflectionActiveTrigger?: unknown;
  reflectionActiveStepCount?: unknown;
  reflectionIdleSweepEnabled?: unknown;
  reflectionIdleSweepIntervalHours?: unknown;
  reflectionIdleConversationMinAgeHours?: unknown;
  reflectionIdleMinUnreflectedTurns?: unknown;
  reflectionSettingsByAgent?: Record<string, PersistedReflectionSettings>;
}

const DEFAULT_REFLECTION_SETTINGS: NormalizedReflectionSettings = {
  trigger: "step-count",
  stepCount: DEFAULT_STEP_COUNT,
  activeTrigger: "step-count",
  activeStepCount: DEFAULT_STEP_COUNT,
  idleSweepEnabled: true,
  idleSweepIntervalHours: DEFAULT_IDLE_SWEEP_INTERVAL_HOURS,
  idleConversationMinAgeHours: DEFAULT_IDLE_CONVERSATION_MIN_AGE_HOURS,
  idleMinUnreflectedTurns: DEFAULT_IDLE_MIN_UNREFLECTED_TURNS,
};

export function normalizeReflectionSettings(
  raw: Partial<ReflectionSettings> = {},
): NormalizedReflectionSettings {
  const activeTrigger = normalizeTrigger(
    raw.activeTrigger ?? raw.trigger,
    DEFAULT_REFLECTION_SETTINGS.activeTrigger,
  );
  const activeStepCount = normalizeStepCount(
    raw.activeStepCount ?? raw.stepCount,
    DEFAULT_REFLECTION_SETTINGS.activeStepCount,
  );
  return {
    trigger: activeTrigger,
    stepCount: activeStepCount,
    activeTrigger,
    activeStepCount,
    idleSweepEnabled:
      typeof raw.idleSweepEnabled === "boolean"
        ? raw.idleSweepEnabled
        : activeTrigger === "off"
          ? false
          : DEFAULT_REFLECTION_SETTINGS.idleSweepEnabled,
    idleSweepIntervalHours: normalizePositiveNumber(
      raw.idleSweepIntervalHours,
      DEFAULT_REFLECTION_SETTINGS.idleSweepIntervalHours,
    ),
    idleConversationMinAgeHours: normalizePositiveNumber(
      raw.idleConversationMinAgeHours,
      DEFAULT_REFLECTION_SETTINGS.idleConversationMinAgeHours,
    ),
    idleMinUnreflectedTurns: normalizePositiveInteger(
      raw.idleMinUnreflectedTurns,
      DEFAULT_REFLECTION_SETTINGS.idleMinUnreflectedTurns,
    ),
  };
}

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

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
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
  base: NormalizedReflectionSettings,
  raw: {
    reflectionTrigger?: unknown;
    reflectionStepCount?: unknown;
    reflectionActiveTrigger?: unknown;
    reflectionActiveStepCount?: unknown;
    reflectionIdleSweepEnabled?: unknown;
    reflectionIdleSweepIntervalHours?: unknown;
    reflectionIdleConversationMinAgeHours?: unknown;
    reflectionIdleMinUnreflectedTurns?: unknown;
  },
): NormalizedReflectionSettings {
  const activeTrigger = normalizeTrigger(
    raw.reflectionActiveTrigger ?? raw.reflectionTrigger,
    base.activeTrigger,
  );
  const activeStepCount = normalizeStepCount(
    raw.reflectionActiveStepCount ?? raw.reflectionStepCount,
    base.activeStepCount,
  );
  const idleSweepEnabled =
    typeof raw.reflectionIdleSweepEnabled === "boolean"
      ? raw.reflectionIdleSweepEnabled
      : base.idleSweepEnabled;
  return {
    trigger: activeTrigger,
    stepCount: activeStepCount,
    activeTrigger,
    activeStepCount,
    idleSweepEnabled,
    idleSweepIntervalHours: normalizePositiveNumber(
      raw.reflectionIdleSweepIntervalHours,
      base.idleSweepIntervalHours,
    ),
    idleConversationMinAgeHours: normalizePositiveNumber(
      raw.reflectionIdleConversationMinAgeHours,
      base.idleConversationMinAgeHours,
    ),
    idleMinUnreflectedTurns: normalizePositiveInteger(
      raw.reflectionIdleMinUnreflectedTurns,
      base.idleMinUnreflectedTurns,
    ),
  };
}

function applyPersistedAgentScopedSettings(
  base: NormalizedReflectionSettings,
  raw: PersistedReflectionSettings | undefined,
): NormalizedReflectionSettings {
  if (!raw) {
    return normalizeReflectionSettings(base);
  }

  const activeTrigger = normalizeTrigger(
    raw.activeTrigger ?? raw.trigger,
    base.activeTrigger,
  );
  const activeStepCount = normalizeStepCount(
    raw.activeStepCount ?? raw.stepCount,
    base.activeStepCount,
  );
  const idleSweepEnabled =
    typeof raw.idleSweepEnabled === "boolean"
      ? raw.idleSweepEnabled
      : base.idleSweepEnabled;
  return {
    trigger: activeTrigger,
    stepCount: activeStepCount,
    activeTrigger,
    activeStepCount,
    idleSweepEnabled,
    idleSweepIntervalHours: normalizePositiveNumber(
      raw.idleSweepIntervalHours,
      base.idleSweepIntervalHours,
    ),
    idleConversationMinAgeHours: normalizePositiveNumber(
      raw.idleConversationMinAgeHours,
      base.idleConversationMinAgeHours,
    ),
    idleMinUnreflectedTurns: normalizePositiveInteger(
      raw.idleMinUnreflectedTurns,
      base.idleMinUnreflectedTurns,
    ),
  };
}

function legacyModeToReflectionSettings(
  mode: MemoryReminderMode | undefined,
): NormalizedReflectionSettings {
  if (typeof mode === "number") {
    const stepCount = normalizeStepCount(mode, DEFAULT_STEP_COUNT);
    return {
      trigger: "step-count",
      stepCount,
      activeTrigger: "step-count",
      activeStepCount: stepCount,
      idleSweepEnabled: true,
      idleSweepIntervalHours: DEFAULT_IDLE_SWEEP_INTERVAL_HOURS,
      idleConversationMinAgeHours: DEFAULT_IDLE_CONVERSATION_MIN_AGE_HOURS,
      idleMinUnreflectedTurns: DEFAULT_IDLE_MIN_UNREFLECTED_TURNS,
    };
  }

  if (mode === null) {
    return {
      trigger: "off",
      activeTrigger: "off",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
      activeStepCount: DEFAULT_REFLECTION_SETTINGS.activeStepCount,
      idleSweepEnabled: false,
      idleSweepIntervalHours: DEFAULT_IDLE_SWEEP_INTERVAL_HOURS,
      idleConversationMinAgeHours: DEFAULT_IDLE_CONVERSATION_MIN_AGE_HOURS,
      idleMinUnreflectedTurns: DEFAULT_IDLE_MIN_UNREFLECTED_TURNS,
    };
  }

  if (mode === "compaction") {
    return {
      trigger: "compaction-event",
      activeTrigger: "compaction-event",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
      activeStepCount: DEFAULT_REFLECTION_SETTINGS.activeStepCount,
      idleSweepEnabled: true,
      idleSweepIntervalHours: DEFAULT_IDLE_SWEEP_INTERVAL_HOURS,
      idleConversationMinAgeHours: DEFAULT_IDLE_CONVERSATION_MIN_AGE_HOURS,
      idleMinUnreflectedTurns: DEFAULT_IDLE_MIN_UNREFLECTED_TURNS,
    };
  }

  if (mode === "auto-compaction") {
    return {
      trigger: "compaction-event",
      activeTrigger: "compaction-event",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
      activeStepCount: DEFAULT_REFLECTION_SETTINGS.activeStepCount,
      idleSweepEnabled: true,
      idleSweepIntervalHours: DEFAULT_IDLE_SWEEP_INTERVAL_HOURS,
      idleConversationMinAgeHours: DEFAULT_IDLE_CONVERSATION_MIN_AGE_HOURS,
      idleMinUnreflectedTurns: DEFAULT_IDLE_MIN_UNREFLECTED_TURNS,
    };
  }

  return { ...DEFAULT_REFLECTION_SETTINGS };
}

export function reflectionSettingsToLegacyMode(
  settings: ReflectionSettings,
): MemoryReminderMode {
  const normalized = normalizeReflectionSettings(settings);
  if (normalized.activeTrigger === "off") {
    return null;
  }
  if (normalized.activeTrigger === "compaction-event") {
    return "auto-compaction";
  }
  return normalizeStepCount(normalized.activeStepCount, DEFAULT_STEP_COUNT);
}

/**
 * Get effective reflection settings (local overrides global with legacy fallback).
 */
export function getReflectionSettings(
  agentId?: string,
  workingDirectory: string = process.cwd(),
): NormalizedReflectionSettings {
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
  turnsSinceLastSuccessfulReflection: number,
  settings: ReflectionSettings = getReflectionSettings(),
): boolean {
  const normalized = normalizeReflectionSettings(settings);
  if (normalized.activeTrigger !== "step-count") {
    return false;
  }
  const stepCount = normalizeStepCount(
    normalized.activeStepCount,
    DEFAULT_STEP_COUNT,
  );
  return turnsSinceLastSuccessfulReflection >= stepCount;
}

function shouldFireLegacyTurnCountReminder(
  turnCount: number,
  settings: ReflectionSettings,
): boolean {
  const normalized = normalizeReflectionSettings(settings);
  if (normalized.activeTrigger !== "step-count") {
    return false;
  }
  const stepCount = normalizeStepCount(
    normalized.activeStepCount,
    DEFAULT_STEP_COUNT,
  );
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
  if (reflectionSettings.activeTrigger !== "step-count") {
    return "";
  }

  if (shouldFireLegacyTurnCountReminder(turnCount, reflectionSettings)) {
    debugLog(
      "memory",
      `Turn-based memory reminder fired (turn ${turnCount}, interval ${reflectionSettings.activeStepCount}, agent ${agentId})`,
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
  const normalizedSettings = normalizeReflectionSettings(settings);
  const {
    workingDirectory = process.cwd(),
    persistLocalProject = true,
    persistGlobal = true,
  } = options;
  const legacyMode = reflectionSettingsToLegacyMode(normalizedSettings);

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
        reflectionTrigger: normalizedSettings.activeTrigger,
        reflectionStepCount: normalizedSettings.activeStepCount,
        reflectionActiveTrigger: normalizedSettings.activeTrigger,
        reflectionActiveStepCount: normalizedSettings.activeStepCount,
        reflectionIdleSweepEnabled: normalizedSettings.idleSweepEnabled,
        reflectionIdleSweepIntervalHours:
          normalizedSettings.idleSweepIntervalHours,
        reflectionIdleConversationMinAgeHours:
          normalizedSettings.idleConversationMinAgeHours,
        reflectionIdleMinUnreflectedTurns:
          normalizedSettings.idleMinUnreflectedTurns,
        reflectionSettingsByAgent: {
          ...(localSettings.reflectionSettingsByAgent ?? {}),
          [agentId]: {
            trigger: normalizedSettings.activeTrigger,
            stepCount: normalizedSettings.activeStepCount,
            activeTrigger: normalizedSettings.activeTrigger,
            activeStepCount: normalizedSettings.activeStepCount,
            idleSweepEnabled: normalizedSettings.idleSweepEnabled,
            idleSweepIntervalHours: normalizedSettings.idleSweepIntervalHours,
            idleConversationMinAgeHours:
              normalizedSettings.idleConversationMinAgeHours,
            idleMinUnreflectedTurns: normalizedSettings.idleMinUnreflectedTurns,
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
      reflectionTrigger: normalizedSettings.activeTrigger,
      reflectionStepCount: normalizedSettings.activeStepCount,
      reflectionActiveTrigger: normalizedSettings.activeTrigger,
      reflectionActiveStepCount: normalizedSettings.activeStepCount,
      reflectionIdleSweepEnabled: normalizedSettings.idleSweepEnabled,
      reflectionIdleSweepIntervalHours:
        normalizedSettings.idleSweepIntervalHours,
      reflectionIdleConversationMinAgeHours:
        normalizedSettings.idleConversationMinAgeHours,
      reflectionIdleMinUnreflectedTurns:
        normalizedSettings.idleMinUnreflectedTurns,
      reflectionSettingsByAgent: {
        ...(globalSettings.reflectionSettingsByAgent ?? {}),
        [agentId]: {
          trigger: normalizedSettings.activeTrigger,
          stepCount: normalizedSettings.activeStepCount,
          activeTrigger: normalizedSettings.activeTrigger,
          activeStepCount: normalizedSettings.activeStepCount,
          idleSweepEnabled: normalizedSettings.idleSweepEnabled,
          idleSweepIntervalHours: normalizedSettings.idleSweepIntervalHours,
          idleConversationMinAgeHours:
            normalizedSettings.idleConversationMinAgeHours,
          idleMinUnreflectedTurns: normalizedSettings.idleMinUnreflectedTurns,
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
            normalizeReflectionSettings({
              trigger: "step-count",
              stepCount: MEMORY_INTERVAL_FREQUENT,
            }),
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
            normalizeReflectionSettings({
              trigger: "step-count",
              stepCount: MEMORY_INTERVAL_OCCASIONAL,
            }),
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
