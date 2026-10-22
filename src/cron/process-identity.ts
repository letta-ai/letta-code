import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import { basename } from "node:path";

interface ProcessIdentity {
  startTicks: string | null;
  bootId: string | null;
}

interface PidReuseProbe {
  platform: NodeJS.Platform;
  /** Epoch ms of the current OS boot. */
  bootTimeMs: () => number;
  /** The pid's command line, or null when it cannot be determined. */
  getProcessCommand: (pid: number) => string | null;
}

// Tolerates clock jitter between `started_at` and the uptime-derived boot time.
const BOOT_TIME_SLACK_MS = 60_000;

const defaultPidReuseProbe: PidReuseProbe = {
  platform: process.platform,
  bootTimeMs: () => Date.now() - uptime() * 1000,
  // Reads the command line via `ps`; same approach as letta-code#5205 (unmerged).
  getProcessCommand: (pid) => {
    if (process.platform === "win32") return null;
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf-8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  },
};

let pidReuseProbe: PidReuseProbe = defaultPidReuseProbe;

let readProcessIdentityOverride:
  | ((pid: number) => ProcessIdentity | null)
  | null = null;

function readLinuxProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endCommand = stat.lastIndexOf(")");
    if (endCommand === -1) {
      return null;
    }

    // /proc/<pid>/stat wraps the command name in parentheses as field #2.
    // Everything after that begins at field #3 ("state"), so starttime
    // (field #22) is offset 19 in the remaining array.
    const fields = stat
      .slice(endCommand + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19] ?? null;
    if (!startTicks) {
      return null;
    }

    let bootId: string | null = null;
    try {
      bootId =
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      // Best effort: boot_id is helpful but not required.
    }

    return { startTicks, bootId };
  } catch {
    return null;
  }
}

function readProcessIdentity(pid: number): ProcessIdentity | null {
  if (readProcessIdentityOverride) {
    return readProcessIdentityOverride(pid);
  }
  return readLinuxProcessIdentity(pid);
}

export function captureProcessIdentity(pid: number): {
  process_start_ticks: string | null;
  boot_id: string | null;
} {
  const identity = readProcessIdentity(pid);
  return {
    process_start_ticks: identity?.startTicks ?? null,
    boot_id: identity?.bootId ?? null,
  };
}

export function isProcessAlive(
  pid: number,
  owner?: {
    process_start_ticks?: string | null;
    boot_id?: string | null;
    started_at?: string;
  } | null,
): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // On Linux, compare the persisted process identity as well. This lets us
  // distinguish "same PID, different process" across container restarts.
  if (owner) {
    const identity = readProcessIdentity(pid);
    if (identity) {
      if (
        owner.boot_id &&
        identity.bootId &&
        owner.boot_id !== identity.bootId
      ) {
        return false;
      }
      if (
        owner.process_start_ticks &&
        identity.startTicks &&
        owner.process_start_ticks !== identity.startTicks
      ) {
        return false;
      }
    }
  }

  // Our own pid is alive by definition; never run reuse heuristics on it.
  if (pid === process.pid) return true;

  if (owner && pidReuseProbe.platform !== "linux") {
    return !isPidReusedSinceBoot(pid, owner.started_at);
  }

  return true;
}

/**
 * Without /proc identity (macOS, Windows), a live pid recorded before the
 * current boot may belong to an unrelated process after a reboot. The boot
 * estimate moves with the wall clock, so it only prompts a closer look: the
 * owner is stale only when its pid is positively identified as non-letta.
 */
function isPidReusedSinceBoot(pid: number, startedAt?: string): boolean {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (
    !Number.isFinite(startedAtMs) ||
    startedAtMs >= pidReuseProbe.bootTimeMs() - BOOT_TIME_SLACK_MS
  ) {
    return false;
  }
  const command = pidReuseProbe.getProcessCommand(pid);
  return Boolean(command) && !isLettaCommand(command ?? "");
}

/**
 * Treats a command as letta if it mentions "letta" (case-insensitive), runs
 * this process's entry script, or uses this process's runtime, so dev/bun-run
 * listeners are not reclaimed.
 */
function isLettaCommand(command: string): boolean {
  if (/letta/i.test(command)) return true;
  const script = process.argv[1];
  if (script && command.includes(script)) return true;
  const argv0 = command.split(/\s+/)[0] ?? "";
  return (
    argv0 === process.execPath || basename(argv0) === basename(process.execPath)
  );
}

export function __testOverridePidReuseProbe(
  overrides: Partial<PidReuseProbe> | null,
): void {
  pidReuseProbe = { ...defaultPidReuseProbe, ...overrides };
}

export function __testOverrideReadProcessIdentity(
  fn: ((pid: number) => ProcessIdentity | null) | null,
): void {
  readProcessIdentityOverride = fn;
}
