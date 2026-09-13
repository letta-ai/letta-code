import {
  splitShellSegments,
  splitShellSegmentsAllowCommandSubstitution,
  tokenizeShellWords,
} from "@/permissions/shell-analysis";

export const FOREGROUND_SLEEP_BLOCKED_MESSAGE =
  'Foreground `sleep` is blocked — it stalls the session while nothing happens. Run the wait in the background and keep working: use Bash with `run_in_background` and a command that exits when the condition is true, e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done`. You get a single completion notification when it exits. For one notification per occurrence ("tell me every time an ERROR line appears"), use the Monitor tool instead. `sleep` inside `run_in_background` commands and Monitor scripts is fine.';

// Reserved words that can precede the command word in a segment produced by
// splitShellSegments (which splits on `;`, `|`, `&&`, `||`, and newlines but
// leaves loop/conditional keywords attached to their statement).
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

/**
 * True when the command would execute `sleep` in the foreground: `sleep` in
 * command position in any top-level segment, including loop bodies
 * (`while true; do sleep 1; done`).
 *
 * This is a workflow nudge, not a security boundary — commands the splitter
 * cannot analyze (unsafe redirects, substitutions in double quotes) are let
 * through rather than blocked, and `sleep` in argument position
 * (`grep sleep file.txt`) never matches.
 */
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
      // First non-keyword, non-assignment word is the command; the rest of
      // the segment is arguments.
      break;
    }
  }
  return false;
}
