import {
  isShellExecutor,
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

const PYTHON_SLEEP =
  /^import\s+time\s*[;\n]\s*(?:(?:while\s+(?:True|1)|for\s+\w+\s+in\s+range\(\d+\))\s*:\s*)?time\.sleep\(\s*\d*\.?\d+\s*\)\s*;?$/;
const PYTHON_IMPORTED_SLEEP =
  /^from\s+time\s+import\s+sleep\s*[;\n]\s*(?:(?:while\s+(?:True|1)|for\s+\w+\s+in\s+range\(\d+\))\s*:\s*)?sleep\(\s*\d*\.?\d+\s*\)\s*;?$/;
const NODE_SLEEP =
  /^setTimeout\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*,\s*\d+\s*\)\s*;?$/;
const NODE_PROMISE_SLEEP =
  /^(?:await\s+)?new\s+Promise\(\s*(\w+)\s*=>\s*setTimeout\(\s*\1\s*,\s*\d+\s*\)\s*\)\s*;?$/;
const PERL_SLEEP =
  /^(?:sleep\s*(?:\d+|\(\s*\d+\s*\))(?:\s+while\s+1)?|while\s*\(\s*1\s*\)\s*\{\s*sleep\s+\d+\s*;?\s*\})\s*;?$/;

function runsSleep(command: string, shellDepth: number): boolean {
  const segments =
    splitShellSegmentsAllowCommandSubstitution(command) ??
    splitShellSegments(command);
  if (!segments) {
    return false;
  }
  for (const segment of segments) {
    const words = tokenizeShellWords(segment);
    const commandIndex = words.findIndex(
      (word) => !SHELL_KEYWORDS.has(word) && !ASSIGNMENT_PREFIX.test(word),
    );
    const executable = words[commandIndex]?.split("/").pop();
    if (executable === "sleep") return true;

    const flag = words[commandIndex + 1];
    const script = words[commandIndex + 2]?.trim();
    if (!script) continue;
    if (
      executable &&
      isShellExecutor(executable) &&
      flag &&
      /^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag) &&
      shellDepth < 8 &&
      !script.includes("<<") &&
      runsSleep(script, shellDepth + 1)
    ) {
      return true;
    }
    if (
      (executable === "python" || executable === "python3") &&
      flag === "-c" &&
      (PYTHON_SLEEP.test(script) || PYTHON_IMPORTED_SLEEP.test(script))
    ) {
      return true;
    }
    if (
      executable === "node" &&
      (flag === "-e" || flag === "--eval") &&
      (NODE_SLEEP.test(script) || NODE_PROMISE_SLEEP.test(script))
    ) {
      return true;
    }
    if (executable === "perl" && flag === "-e" && PERL_SLEEP.test(script)) {
      return true;
    }
  }
  return false;
}

export function commandRunsForegroundSleep(command: string): boolean {
  return runsSleep(command, 0);
}
