import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import {
  splitShellSegments,
  tokenizeShellWords,
} from "@/permissions/shell-analysis";

type ProcessInfo = { parent: number; group: number };
type ProcessLookup = {
  pid: number;
  info: (pid: number) => ProcessInfo | undefined;
  pgrep: (args: string[]) => number[];
};

function readProcessInfo(pid: number): ProcessInfo | undefined {
  let fields: string[];
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .split(" ")
        .slice(1);
    } catch {
      return undefined;
    }
  } else if (process.platform === "darwin") {
    const result = spawnSync(
      "ps",
      ["-o", "ppid=", "-o", "pgid=", "-p", String(pid)],
      {
        encoding: "utf8",
        timeout: 250,
      },
    );
    if (result.status !== 0) return undefined;
    fields = result.stdout.trim().split(/\s+/);
  } else {
    return undefined;
  }
  const [parent, group] = fields.map(Number);
  if (parent === undefined || group === undefined) return undefined;
  return { parent, group };
}

function* walkProcessAncestors(pid: number, info: ProcessLookup["info"]) {
  const visited = new Set<number>();
  while (pid > 0 && !visited.has(pid)) {
    yield pid;
    visited.add(pid);
    pid = info(pid)?.parent ?? 0;
  }
}

let protectedPids: readonly number[] | undefined;

export function getProtectedShellPids(): readonly number[] {
  protectedPids ??= [...walkProcessAncestors(process.pid, readProcessInfo)];
  return protectedPids;
}

function pgrep(args: string[]): number[] {
  if (process.platform !== "linux" && process.platform !== "darwin") return [];
  const result = spawnSync("pgrep", args, { encoding: "utf8", timeout: 250 });
  if (result.status !== 0) return [];
  // Some options also print the matching command or use a custom delimiter.
  return result.stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const pid = Number(line.match(/^\d+(?=\s|$)/)?.[0]);
      return Number.isSafeInteger(pid) ? [pid] : [];
    });
}

function isSignal(value: string): boolean {
  return (
    /^\d+$/.test(value) ||
    Object.hasOwn(
      constants.signals,
      `SIG${value.toUpperCase().replace(/^SIG/, "")}`,
    )
  );
}

function matchingTargets(
  tool: string,
  args: string[],
  lookup: ProcessLookup,
  substitutions: Map<string, string[]>,
): number[] {
  const first = args[0];
  if (
    tool === "kill" &&
    (first === "-l" || first === "-L" || first === "--list")
  ) {
    return [];
  }
  if (
    (first === "-s" && tool !== "pkill") ||
    first === "--signal" ||
    (first === "-n" && tool === "kill")
  ) {
    if (!args[1] || !isSignal(args[1]) || Number(args[1]) === 0) return [];
    args = args.slice(2);
  } else if (first?.startsWith("--signal=")) {
    if (!isSignal(first.slice(9)) || Number(first.slice(9)) === 0) return [];
    args = args.slice(1);
  } else if (first?.startsWith("-") && isSignal(first.slice(1))) {
    if (Number(first.slice(1)) === 0) return [];
    // A leading negative number in kill is the signal. Group operands
    // follow a signal, a PID, or the explicit end-of-options marker.
    args = args.slice(1);
  }

  if (tool === "kill") {
    if (args[0]?.startsWith("-") && args[0] !== "--" && !/^-\d+$/.test(args[0]))
      return [];
    return args.flatMap((arg) => {
      const inner = substitutions.get(arg);
      if (inner) return lookup.pgrep(inner);
      return /^-?\d+$/.test(arg) && Number.isSafeInteger(Number(arg))
        ? [Number(arg)]
        : [];
    });
  }

  if (
    args.some(
      (arg) => substitutions.has(arg) || /\$(?=\w|[({!$?])|[`\\]/.test(arg),
    )
  ) {
    return [];
  }
  if (tool === "pkill") return lookup.pgrep(args);

  const names = args[0] === "--" ? args.slice(1) : args;
  if (names.some((name) => name.startsWith("-"))) return [];
  return names.flatMap((name) =>
    lookup.pgrep(["-x", "--", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")]),
  );
}

/**
 * Best-effort check for accidental signals to the harness. Only resolve simple
 * pgrep substitutions, using argv directly and never executing shell text.
 */
export function findProtectedShellProcess(
  command: string,
  lookup: ProcessLookup = { pid: process.pid, info: readProcessInfo, pgrep },
): string | undefined {
  if (!/\b(?:kill|pkill|killall)\b/.test(command)) return undefined;
  const substitutions = new Map<string, string[]>();
  let hasHeredoc = false;
  const normalized = command.replace(
    /\\[\s\S]|'[^']*'|(?<=\s)(?<quote>"?)(?:\$\((?<parens>pgrep\s+[^()`$;&|<>\n]+)\)|`(?<backticks>pgrep\s+[^`$;&|<>\n]+)`)\k<quote>(?=\s|[;&|]|$)|"(?:[^"\\]|\\.)*"|(?:^|(?<=[\s;&|]))#[^\n]*|<</g,
    (
      word,
      _quote: string,
      parens: string | undefined,
      backticks: string | undefined,
    ) => {
      const inner = parens ?? backticks;
      if (!inner) {
        if (word === "<<") hasHeredoc = true;
        return word.startsWith("#") ? "" : word;
      }
      let key = `__pgrep_${substitutions.size}__`;
      while (command.includes(key)) key += "_";
      substitutions.set(key, tokenizeShellWords(inner).slice(1));
      return key;
    },
  );

  if (hasHeredoc) return undefined;
  const segments = splitShellSegments(normalized, {
    splitBackground: true,
  });
  if (!segments) return undefined;
  for (const segment of segments) {
    const [word, ...args] = tokenizeShellWords(
      segment.replace(
        /^(?:(?:if|then|elif|else|while|until|do|command|builtin|exec|!)\s+|\w+=\S+\s+)*/,
        "",
      ),
    );
    const tool = word?.split("/").pop();
    if (tool !== "kill" && tool !== "pkill" && tool !== "killall") continue;
    const targets = matchingTargets(tool, args, lookup, substitutions);
    if (targets.length === 0) continue;
    const group = lookup.info(lookup.pid)?.group;
    if (group && targets.includes(-group))
      return `the process group (PGID ${group}) of the Letta Code CLI running this agent`;
    if (targets.includes(-1))
      return `the Letta Code CLI running this agent (PID ${lookup.pid}) along with other accessible processes`;
    const pids =
      lookup.info === readProcessInfo && lookup.pid === process.pid
        ? getProtectedShellPids()
        : walkProcessAncestors(lookup.pid, lookup.info);
    for (const pid of pids) {
      if (targets.includes(pid)) {
        return pid === lookup.pid
          ? `the Letta Code CLI running this agent (PID ${pid})`
          : `an ancestor (PID ${pid}) of the Letta Code CLI running this agent`;
      }
    }
  }
  return undefined;
}

export function protectedShellProcessMessage(target: string): string {
  return `Blocked: This command would signal ${target}. Target a specific child PID such as $!, or use KillBash to stop a background task.`;
}
