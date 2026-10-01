import { readFileSync } from "node:fs";

interface ProcessIdentity {
  startTicks: string | null;
  bootId: string | null;
}

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

  return true;
}

export function __testOverrideReadProcessIdentity(
  fn: ((pid: number) => ProcessIdentity | null) | null,
): void {
  readProcessIdentityOverride = fn;
}
