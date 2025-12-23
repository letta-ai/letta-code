// src/cli/helpers/memoryReminder.ts
// Handles periodic memory reminder logic and preference parsing

import { settingsManager } from "../../settings-manager";

/**
 * Build a memory check reminder if the turn count matches the interval
 * @param turnCount - Current conversation turn count
 * @returns Promise resolving to the reminder string (empty if not applicable)
 */
export async function buildMemoryReminder(turnCount: number): Promise<string> {
  const memoryInterval = settingsManager.getSetting("memoryReminderInterval");

  if (
    memoryInterval &&
    turnCount > 0 &&
    turnCount % memoryInterval === 0
  ) {
    const { MEMORY_CHECK_REMINDER } = await import(
      "../../agent/promptAssets.js"
    );
    return `<system-reminder>\n${MEMORY_CHECK_REMINDER}\n</system-reminder>`;
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

      // Parse answer: "proactive" / "frequent" / "more" → 5, "less" / "occasional" → 10
      if (
        answer.includes("proactive") ||
        answer.includes("frequent") ||
        answer.includes("more") ||
        answer.includes("often")
      ) {
        settingsManager.updateSettings({ memoryReminderInterval: 5 });
        return true;
      } else if (
        answer.includes("less") ||
        answer.includes("occasional") ||
        answer.includes("infrequent")
      ) {
        settingsManager.updateSettings({ memoryReminderInterval: 10 });
        return true;
      }
      break; // Only process first matching question
    }
  }
  return false;
}
