import {
  splitShellSegments,
  splitShellSegmentsAllowCommandSubstitution,
  tokenizeShellWords,
} from "@/permissions/shell-analysis";

export function selfMatchingPgrepMessage(pattern: string): string {
  return `This command is blocked: \`pgrep -f\`/\`pkill -f\` match against full command lines, and the pattern \`${pattern}\` also matches this command's own shell (it runs as \`bash -c "<your command>"\`). A wait loop on it never ends, and \`pkill -f\` would kill this command. To wait for a process, start it in the background and \`wait <pid>\` (or \`while kill -0 <pid>\`), or match a name that isn't in this command.`;
}

const PROCESS_MATCHERS = new Set(["pgrep", "pkill"]);
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
// Options that take a value, so the next word is not the pattern.
const OPTIONS_WITH_VALUE = new Set([
  "-d",
  "-g",
  "-G",
  "-P",
  "-s",
  "-t",
  "-u",
  "-U",
  "-F",
  "--delimiter",
  "--pgroup",
  "--group",
  "--parent",
  "--session",
  "--terminal",
  "--euid",
  "--uid",
  "--pidfile",
  "--signal",
  "--ns",
  "--nslist",
]);

function matchesFullCommandLine(option: string): boolean {
  if (option === "--full") return true;
  // Combined short flags such as -af or -fl.
  return /^-[A-Za-z]*f[A-Za-z]*$/.test(option) && !option.startsWith("--");
}

function patternMatches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return text.includes(pattern);
  }
}

/**
 * Returns the pattern of a `pgrep -f` / `pkill -f` in this command that also
 * matches the command itself, or null. The Bash tool runs commands as
 * `<shell> -c "<command>"`, so that shell's command line contains every pattern
 * written into the command; pgrep excludes only its own process, not the shell.
 *
 * Like the foreground-sleep check, this is a workflow guard, not a security
 * boundary: commands the splitter cannot analyze are let through.
 */
export function findSelfMatchingPgrepPattern(command: string): string | null {
  const segments =
    splitShellSegmentsAllowCommandSubstitution(command) ??
    splitShellSegments(command);
  if (!segments) return null;
  for (const segment of segments) {
    const words = tokenizeShellWords(segment);
    let index = 0;
    while (
      index < words.length &&
      (SHELL_KEYWORDS.has(words[index] ?? "") ||
        ASSIGNMENT_PREFIX.test(words[index] ?? ""))
    ) {
      index += 1;
    }
    const commandWord = words[index]?.split("/").pop();
    if (!commandWord || !PROCESS_MATCHERS.has(commandWord)) continue;
    let fullMatch = false;
    let pattern: string | undefined;
    for (let i = index + 1; i < words.length; i += 1) {
      const word = words[i] ?? "";
      if (word === "--") {
        pattern = words[i + 1];
        break;
      }
      if (word.startsWith("-")) {
        if (matchesFullCommandLine(word)) fullMatch = true;
        if (OPTIONS_WITH_VALUE.has(word)) i += 1;
        continue;
      }
      pattern = word;
      break;
    }
    if (fullMatch && pattern && patternMatches(pattern, command)) {
      return pattern;
    }
  }
  return null;
}
