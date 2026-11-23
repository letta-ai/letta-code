import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import {
  getProcessCommand,
  isPidReusedByNonLetta,
} from "@/utils/process-liveness";

interface ProcessIdentity {
  startTicks: string | null;
  bootId: string | null;
}

interface PidReuseProbe {
  platform: NodeJS.Platform;
  bootTimeMs: () => number;
  getProcessCommand: (pid: number) => string | null;
}

const BOOT_TIME_SLACK_MS = 60_000;

const defaultPidReuseProbe: PidReuseProbe = {
  platform: process.platform,
  bootTimeMs: () => Date.now() - uptime() * 1000,
  getProcessCommand,
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
    } catch {}

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

  if (owner && pidReuseProbe.platform !== "linux") {
    return !isPidReusedSinceBoot(pid, owner.started_at);
  }

  return true;
}

function isPidReusedSinceBoot(pid: number, startedAt?: string): boolean {
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (
    !Number.isFinite(startedAtMs) ||
    startedAtMs >= pidReuseProbe.bootTimeMs() - BOOT_TIME_SLACK_MS
  ) {
    return false;
  }
  return isPidReusedByNonLetta(pid, pidReuseProbe.getProcessCommand);
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
