import {
  splitShellSegments,
  splitShellSegmentsAllowCommandSubstitution,
  tokenizeShellWords,
} from "@/permissions/shell-analysis";

export const FOREGROUND_SLEEP_BLOCKED_MESSAGE =
  "Foreground `sleep` is blocked. If you are waiting on a task you already started, its completion notification will arrive on its own; keep working or end your turn. To wait for a condition, run the command with `run_in_background` (or use the Monitor tool for repeated events). `sleep` inside `run_in_background` commands and Monitor scripts is fine.";

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "for",
  "case",
  "esac",
  "{",
  "}",
  "(",
  ")",
  "!",
  "time",
]);

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function commandRunsForegroundSleep(command: string): boolean {
  const segments =
    splitShellSegmentsAllowCommandSubstitution(command) ??
    splitShellSegments(command);
  if (!segments) {
    return false;
  }
  for (const segment of segments) {
    for (const word of tokenizeShellWords(segment)) {
      if (SHELL_KEYWORDS.has(word)) {
        continue;
      }
      if (ASSIGNMENT_PREFIX.test(word)) {
        continue;
      }
      if (word.split("/").pop() === "sleep") {
        return true;
      }
      break;
    }
  }
  return false;
}
