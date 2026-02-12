// src/cli/helpers/memoryReminder.ts
// Handles periodic memory reminder logic and preference parsing

import { settingsManager } from "../../settings-manager";
import { debugLog } from "../../utils/debug";

// Memory reminder interval presets
const MEMORY_INTERVAL_FREQUENT = 5;
const MEMORY_INTERVAL_OCCASIONAL = 10;

export type MemoryReminderMode =
  | number
  | null
  | "compaction"
  | "auto-compaction";

/**
 * Get the effective memory reminder mode (local setting takes precedence over global)
 * @returns The reminder mode (number, compaction mode, or null if disabled)
 */
export function getMemoryReminderMode(): MemoryReminderMode {
  // Check local settings first (may not be loaded, so catch errors)
  try {
    const localSettings = settingsManager.getLocalProjectSettings();
    if (localSettings.memoryReminderInterval !== undefined) {
      return localSettings.memoryReminderInterval as MemoryReminderMode;
    }
  } catch {
    // Local settings not loaded, fall through to global
  }

  // Fall back to global setting
  return settingsManager.getSetting(
    "memoryReminderInterval",
  ) as MemoryReminderMode;
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
  const memoryMode = getMemoryReminderMode();
  if (typeof memoryMode !== "number" || memoryMode <= 0) {
    return "";
  }

  if (turnCount > 0 && turnCount % memoryMode === 0) {
    debugLog(
      "memory",
      `Turn-based memory reminder fired (turn ${turnCount}, interval ${memoryMode}, agent ${agentId})`,
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
        });
        return true;
      } else if (answer.includes("occasional")) {
        settingsManager.updateLocalProjectSettings({
          memoryReminderInterval: MEMORY_INTERVAL_OCCASIONAL,
        });
        return true;
      }
      break; // Only process first matching question
    }
  }
  return false;
}
