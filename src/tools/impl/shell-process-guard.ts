import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getProtectedShellPids } from "./protected-shell-processes.js";

const signals = Object.keys(constants.signals)
  .flatMap((signal) => [signal, signal.slice(3)])
  .flatMap((name) => [`-${name}`, `-${name.toLowerCase()}`])
  .join("|");

// getopt may accept abbreviated long options for a nonzero signal.
const signalOptionAbbreviations =
  "--s|--si|--sig|--sign|--signa|--s=*|--si=*|--sig=*|--sign=*|--signa=*";

/**
 * Best-effort workflow guard for direct shell calls. Shell functions don't
 * apply to xargs, sudo, or separately launched scripts. This is not a
 * security boundary.
 */
const shim = String.raw`
__letta_has_ignore_ancestors() {
  case ${"$"}{__letta_ignore_ancestors-} in
    yes) return 0 ;;
    no) return 1 ;;
  esac
  local probe_status=0
  command pgrep --ignore-ancestors -x __letta_probe__ >/dev/null 2>&1 || probe_status=$?
  case $probe_status in
    0|1) __letta_ignore_ancestors=yes; return 0 ;;
    *) __letta_ignore_ancestors=no; return 1 ;;
  esac
}

pgrep() {
  if __letta_has_ignore_ancestors; then
    command pgrep --ignore-ancestors "$@"
  else
    command pgrep "$@"
  fi
}

__letta_refuse_signal() {
  local tool=$1 matches=$2 suggestion=$3 pid protected_pid=
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    if [ "$pid" = "$LETTA_CLI_PID" ]; then
      protected_pid=$pid
      break
    fi
    case " $LETTA_PROTECTED_PIDS " in
      *" $pid "*) protected_pid=$pid ;;
    esac
  done <<LEttaMatches
$matches
LEttaMatches
  [ -n "$protected_pid" ] || return 1
  printf '%s: refusing to run — this pattern matches the Letta Code CLI process (PID %s). Narrow the pattern, or target your own children with ${"`"}pkill -P $$ %s${"`"}.\n' "$tool" "$protected_pid" "$suggestion" >&2
}

__letta_pkill_probe() {
  local remaining=$# arg first zero_signal=no other_signal=no
  while [ "$remaining" -gt 0 ]; do
    arg=$1; shift; remaining=$((remaining - 1))
    case "$arg" in
      --)
        # Rotate the unprocessed operands back behind the options and --.
        set -- "$@" "$arg"
        while [ "$remaining" -gt 0 ]; do
          arg=$1; shift; set -- "$@" "$arg"; remaining=$((remaining - 1))
        done
        ;;
      -0|--signal=0) zero_signal=yes ;;
      --signal)
        [ "$remaining" -gt 0 ] || return 2
        if [ "$1" = 0 ]; then zero_signal=yes; else other_signal=yes; fi
        shift; remaining=$((remaining - 1))
        ;;
      -q|--queue)
        [ "$remaining" -gt 0 ] || return 2
        shift; remaining=$((remaining - 1))
        ;;
      --signal=*|-[0-9]*|${signals}) other_signal=yes ;;
      ${signalOptionAbbreviations})
        other_signal=yes; set -- "$@" "$arg"
        ;;
      --queue=*|-e|--echo|-c|--count) ;;
      -[gGOPsTtuUFdr]|--pgroup|--group|--older|--parent|--session|--terminal|--euid|--uid|--pidfile|--runstates|--ns|--nslist|--cgroup|--env)
        [ "$remaining" -gt 0 ] || return 2
        set -- "$@" "$arg" "$1"; shift; remaining=$((remaining - 1))
        ;;
      -[efinvxocAnLw]?*)
        # Peel off one clustered flag, leaving attached option values intact.
        if [ "${"$"}{arg#??}" = 0 ]; then other_signal=yes; fi
        first=${"$"}{arg%"${"$"}{arg#??}"}
        set -- "-${"$"}{arg#??}" "$@"; remaining=$((remaining + 1))
        case "$first" in
          -e|-c) ;;
          *) set -- "$@" "$first" ;;
        esac
        ;;
      *) set -- "$@" "$arg" ;;
    esac
  done
  # Require every explicit signal to be zero before skipping the match check.
  if [ "$zero_signal" = yes ] && [ "$other_signal" = no ]; then return 1; fi
  command pgrep "$@"
}

pkill() {
  local matches probe_status=0
  matches=$(__letta_pkill_probe "$@" 2>/dev/null) || probe_status=$?
  if [ "$probe_status" -eq 0 ] && __letta_refuse_signal pkill "$matches" '...'; then
    return 1
  fi
  if [ "$probe_status" -le 1 ] && __letta_has_ignore_ancestors; then
    command pkill --ignore-ancestors "$@"
  else
    command pkill "$@"
  fi
}

__letta_killall_matches_protected() {
  local remaining=$# arg regexp=no matches pattern zero_signal=no other_signal=no
  while [ "$remaining" -gt 0 ]; do
    arg=$1; shift; remaining=$((remaining - 1))
    case "$arg" in
      --) break ;;
      -r|--regexp${process.platform === "darwin" ? "|-m" : ""}) regexp=yes ;;
      -[egIiqrvw${process.platform === "darwin" ? "m" : ""}]?*)
        if [ "${"$"}{arg#??}" = 0 ]; then other_signal=yes; fi
        set -- "${"$"}{arg%"${"$"}{arg#??}"}" "-${"$"}{arg#??}" "$@"
        remaining=$((remaining + 2))
        ;;
      -0|--signal=0) zero_signal=yes ;;
      -s|--signal)
        [ "$remaining" -gt 0 ] || return 1
        if [ "$1" = 0 ]; then zero_signal=yes; else other_signal=yes; fi
        shift; remaining=$((remaining - 1))
        ;;
      -s?*|--signal=*|-[0-9]*|${signals}|${signalOptionAbbreviations})
        other_signal=yes
        ;;
      -u|--user|-o|-y|--older-than|--younger-than|-n|--ns)
        [ "$remaining" -gt 0 ] || return 1
        shift; remaining=$((remaining - 1))
        ;;
      -*) ;;
      *) set -- "$@" "$arg" ;;
    esac
  done
  if [ "$zero_signal" = yes ] && [ "$other_signal" = no ]; then return 1; fi
  for arg do
    if [ "$regexp" = yes ]; then
      matches=$(command pgrep -- "$arg" 2>/dev/null) || continue
    else
      pattern=$(printf '%s\n' "$arg" | sed 's/[][\\.^$*+?(){}|]/\\&/g')
      matches=$(command pgrep -x -- "$pattern" 2>/dev/null) || continue
    fi
    __letta_refuse_signal killall "$matches" "$arg" && return 0
  done
  return 1
}

killall() {
  if __letta_killall_matches_protected "$@"; then
    return 1
  fi
  command killall "$@"
}
`;

let guardPrefix: string | undefined;

function removeGuardDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A cleanup error should not prevent shell execution or CLI shutdown.
  }
}

function getGuardPrefix(): string {
  if (guardPrefix !== undefined) return guardPrefix;
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "letta-shell-"));
    const file = join(dir, "guard");
    writeFileSync(file, shim, { mode: 0o600 });
    const cleanupDir = dir;
    process.once("exit", () => removeGuardDir(cleanupDir));
    guardPrefix = `. '${file.replaceAll("'", "'\\''")}'\n`;
  } catch {
    if (dir) removeGuardDir(dir);
    guardPrefix = shim;
  }
  return guardPrefix;
}

export function withShellProcessGuard(
  launcher: string[],
  env: NodeJS.ProcessEnv,
): { launcher: string[]; env: NodeJS.ProcessEnv } {
  if (process.platform === "win32") return { launcher, env };
  const executable = launcher[0];
  const command = launcher.at(-1);
  const shell = basename(executable ?? "") === "env" ? launcher[1] : executable;
  if (
    !shell ||
    !command ||
    /^(?:fish|nu|pwsh|powershell)(?:\.exe)?$/i.test(basename(shell))
  ) {
    return { launcher, env };
  }
  return {
    launcher: [...launcher.slice(0, -1), getGuardPrefix() + command],
    env: {
      ...env,
      LETTA_CLI_PID: String(process.pid),
      LETTA_PROTECTED_PIDS: getProtectedShellPids().join(" "),
    },
  };
}
