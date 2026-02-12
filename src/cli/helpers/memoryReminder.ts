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
export type ReflectionBehavior = "reminder" | "auto-launch";

export interface ReflectionSettings {
  trigger: ReflectionTrigger;
  behavior: ReflectionBehavior;
  stepCount: number;
}

const DEFAULT_REFLECTION_SETTINGS: ReflectionSettings = {
  trigger: "step-count",
  behavior: "reminder",
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

function normalizeBehavior(
  value: unknown,
  fallback: ReflectionBehavior,
): ReflectionBehavior {
  if (value === "reminder" || value === "auto-launch") {
    return value;
  }
  return fallback;
}

function applyExplicitReflectionOverrides(
  base: ReflectionSettings,
  raw: {
    reflectionTrigger?: unknown;
    reflectionBehavior?: unknown;
    reflectionStepCount?: unknown;
  },
): ReflectionSettings {
  return {
    trigger: normalizeTrigger(raw.reflectionTrigger, base.trigger),
    behavior: normalizeBehavior(raw.reflectionBehavior, base.behavior),
    stepCount: normalizeStepCount(raw.reflectionStepCount, base.stepCount),
  };
}

function legacyModeToReflectionSettings(
  mode: MemoryReminderMode | undefined,
): ReflectionSettings {
  if (typeof mode === "number") {
    return {
      trigger: "step-count",
      behavior: "reminder",
      stepCount: normalizeStepCount(mode, DEFAULT_STEP_COUNT),
    };
  }

  if (mode === null) {
    return {
      trigger: "off",
      behavior: DEFAULT_REFLECTION_SETTINGS.behavior,
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
    };
  }

  if (mode === "compaction") {
    return {
      trigger: "compaction-event",
      behavior: "reminder",
      stepCount: DEFAULT_REFLECTION_SETTINGS.stepCount,
    };
  }

  if (mode === "auto-compaction") {
    return {
      trigger: "compaction-event",
      behavior: "auto-launch",
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
    return settings.behavior === "auto-launch"
      ? "auto-compaction"
      : "compaction";
  }
  return normalizeStepCount(settings.stepCount, DEFAULT_STEP_COUNT);
}

/**
 * Get effective reflection settings (local overrides global with legacy fallback).
 */
export function getReflectionSettings(): ReflectionSettings {
  const globalSettings = settingsManager.getSettings();
  let resolved = legacyModeToReflectionSettings(
    globalSettings.memoryReminderInterval,
  );
  resolved = applyExplicitReflectionOverrides(resolved, globalSettings);

  // Check local settings first (may not be loaded, so catch errors)
  try {
    const localSettings = settingsManager.getLocalProjectSettings();
    if (localSettings.memoryReminderInterval !== undefined) {
      resolved = legacyModeToReflectionSettings(
        localSettings.memoryReminderInterval,
      );
    }
    resolved = applyExplicitReflectionOverrides(resolved, localSettings);
  } catch {
    // Local settings not loaded, fall through to global
  }

  return resolved;
}

/**
 * Legacy mode view used by existing call sites while migrating to split fields.
 */
export function getMemoryReminderMode(): MemoryReminderMode {
  return reflectionSettingsToLegacyMode(getReflectionSettings());
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
  if (settingsManager.isMemfsEnabled(agentId)) {
    debugLog(
      "memory",
      `Reflection reminder fired (${trigger}, agent ${agentId})`,
    );
    const { MEMORY_REFLECTION_REMINDER } = await import(
      "../../agent/promptAssets.js"
    );
    return MEMORY_REFLECTION_REMINDER;
  }

  debugLog(
    "memory",
    `Memory check reminder fired (${trigger}, agent ${agentId})`,
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
 * - MemFS enabled: returns MEMORY_REFLECTION_REMINDER
 *   (instructs agent to launch background reflection Task)
 * - MemFS disabled: returns MEMORY_CHECK_REMINDER
 *   (existing behavior, agent updates memory inline)
 *
 * @param turnCount - Current conversation turn count
 * @param agentId - Current agent ID (needed to check MemFS status)
 * @returns Promise resolving to the reminder string (empty if not applicable)
 */
export async function buildMemoryReminder(
  turnCount: number,
  agentId: string,
): Promise<string> {
  const reflectionSettings = getReflectionSettings();
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
        settingsManager.updateLocalProjectSettings({
          memoryReminderInterval: MEMORY_INTERVAL_FREQUENT,
          reflectionTrigger: "step-count",
          reflectionBehavior: "reminder",
          reflectionStepCount: MEMORY_INTERVAL_FREQUENT,
        });
        return true;
      } else if (answer.includes("occasional")) {
        settingsManager.updateLocalProjectSettings({
          memoryReminderInterval: MEMORY_INTERVAL_OCCASIONAL,
          reflectionTrigger: "step-count",
          reflectionBehavior: "reminder",
          reflectionStepCount: MEMORY_INTERVAL_OCCASIONAL,
        });
        return true;
      }
      break; // Only process first matching question
    }
  }
  return false;
}
