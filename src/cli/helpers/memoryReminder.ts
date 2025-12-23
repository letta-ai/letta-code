// src/cli/helpers/memoryReminder.ts
// Handles periodic memory reminder logic and preference parsing

import { settingsManager } from "../../settings-manager";

// Memory reminder interval presets
const MEMORY_INTERVAL_FREQUENT = 3;
const MEMORY_INTERVAL_OCCASIONAL = 8;

/**
 * Get the effective memory reminder interval (local setting takes precedence over global)
 * @returns The memory interval setting, or null if disabled
 */
function getMemoryInterval(): number | null {
  // Check local settings first (may not be loaded, so catch errors)
  try {
    const localSettings = settingsManager.getLocalProjectSettings();
    if (localSettings.memoryReminderInterval !== undefined) {
      return localSettings.memoryReminderInterval;
    }
  } catch {
    // Local settings not loaded, fall through to global
  }

  // Fall back to global setting
  return settingsManager.getSetting("memoryReminderInterval");
}

/**
 * Build a memory check reminder if the turn count matches the interval
 * @param turnCount - Current conversation turn count
 * @returns Promise resolving to the reminder string (empty if not applicable)
 */
export async function buildMemoryReminder(turnCount: number): Promise<string> {
  const memoryInterval = getMemoryInterval();

  if (memoryInterval && turnCount > 0 && turnCount % memoryInterval === 0) {
    const { MEMORY_CHECK_REMINDER } = await import(
      "../../agent/promptAssets.js"
    );
    return MEMORY_CHECK_REMINDER;
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
