import { statfs } from "node:fs/promises";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Warn when at least this fraction of the volume is used... */
export const DISK_WARNING_USED_FRACTION = 0.85;
/** ...or when less than this many bytes remain available. */
export const DISK_WARNING_AVAILABLE_BYTES = 2 * GIB;
export const DISK_CRITICAL_USED_FRACTION = 0.95;
export const DISK_CRITICAL_AVAILABLE_BYTES = 512 * MIB;
/** A fired level re-arms only after usage drops below its re-arm mark. */
export const DISK_WARNING_REARM_USED_FRACTION = 0.8;
export const DISK_WARNING_REARM_AVAILABLE_BYTES = 3 * GIB;
export const DISK_CRITICAL_REARM_USED_FRACTION = 0.9;
export const DISK_CRITICAL_REARM_AVAILABLE_BYTES = GIB;

export interface DiskSpaceSample {
  path: string;
  totalBytes: number;
  availableBytes: number;
}

export type StatfsFn = (path: string) => Promise<{
  bsize: number;
  blocks: number;
  bavail: number;
}>;

export type DiskPressureLevel = "ok" | "warning" | "critical";

/** Which alerts may still fire in the current episode. */
export interface DiskPressureState {
  warningArmed: boolean;
  criticalArmed: boolean;
}

export async function measureDiskSpace(
  path: string,
  statfsFn: StatfsFn = statfs,
): Promise<DiskSpaceSample> {
  const stats = await statfsFn(path);
  return {
    path,
    totalBytes: stats.blocks * stats.bsize,
    availableBytes: stats.bavail * stats.bsize,
  };
}

function usedFraction(sample: DiskSpaceSample): number {
  return 1 - sample.availableBytes / sample.totalBytes;
}

export function classifyDiskPressure(
  sample: DiskSpaceSample,
): DiskPressureLevel {
  if (sample.totalBytes <= 0) return "ok";
  const used = usedFraction(sample);
  if (
    used >= DISK_CRITICAL_USED_FRACTION ||
    sample.availableBytes < DISK_CRITICAL_AVAILABLE_BYTES
  ) {
    return "critical";
  }
  if (
    used >= DISK_WARNING_USED_FRACTION ||
    sample.availableBytes < DISK_WARNING_AVAILABLE_BYTES
  ) {
    return "warning";
  }
  return "ok";
}

function isBelowRearmMark(
  sample: DiskSpaceSample,
  level: Exclude<DiskPressureLevel, "ok">,
): boolean {
  if (sample.totalBytes <= 0) return true;
  const [fraction, bytes] =
    level === "critical"
      ? [DISK_CRITICAL_REARM_USED_FRACTION, DISK_CRITICAL_REARM_AVAILABLE_BYTES]
      : [DISK_WARNING_REARM_USED_FRACTION, DISK_WARNING_REARM_AVAILABLE_BYTES];
  return usedFraction(sample) < fraction && sample.availableBytes >= bytes;
}

export function createDiskPressureState(): DiskPressureState {
  return { warningArmed: true, criticalArmed: true };
}

/**
 * Pure hysteresis step. Each escalation fires once per episode; a level fires
 * again only after usage fell below that level's re-arm mark. Reaching
 * critical directly also consumes the warning, so recovery to the warning band
 * stays quiet.
 */
export function advanceDiskPressure(
  state: DiskPressureState,
  sample: DiskSpaceSample,
): { state: DiskPressureState; fire: Exclude<DiskPressureLevel, "ok"> | null } {
  const criticalArmed =
    state.criticalArmed || isBelowRearmMark(sample, "critical");
  const warningArmed =
    state.warningArmed || isBelowRearmMark(sample, "warning");
  const level = classifyDiskPressure(sample);
  if (level === "critical" && criticalArmed) {
    return {
      state: { warningArmed: false, criticalArmed: false },
      fire: "critical",
    };
  }
  if (level === "warning" && warningArmed) {
    return { state: { warningArmed: false, criticalArmed }, fire: "warning" };
  }
  return { state: { warningArmed, criticalArmed }, fire: null };
}

function formatBytes(bytes: number): string {
  const gib = bytes / GIB;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / MIB))} MB`;
}

function usedPercent(sample: DiskSpaceSample): number {
  return Math.round(usedFraction(sample) * 100);
}

export function formatDiskSpaceSummary(
  level: Exclude<DiskPressureLevel, "ok">,
  sample: DiskSpaceSample,
): string {
  const label =
    level === "critical" ? "CRITICAL: disk almost full" : "Low disk space";
  return `${label}: ${usedPercent(sample)}% full, ${formatBytes(sample.availableBytes)} free`;
}

/** Guidance shared by the queued notification and the in-request reminder. */
export function formatDiskSpaceGuidance(
  level: Exclude<DiskPressureLevel, "ok">,
  sample: DiskSpaceSample,
): string {
  const headline =
    level === "critical"
      ? "CRITICAL LOW DISK SPACE: stop disk-heavy work now."
      : "LOW DISK SPACE WARNING.";
  return `${headline} The volume holding ${sample.path} is ${usedPercent(sample)}% full (${formatBytes(sample.availableBytes)} available of ${formatBytes(sample.totalBytes)}). Other agents and subagents in this sandbox share this disk. When it fills, file writes, installs, builds, and memory git commits fail with ENOSPC.

Pause large installs and builds until space is freed. Find large directories with \`du -xh --max-depth=2 <dir> | sort -h\`, then delete regenerable data:
- node_modules in worktrees that are not in active use
- package manager caches: npm (~/.npm/_cacache), bun (~/.bun/install/cache), pip (~/.cache/pip), uv (~/.cache/uv)
- build output such as dist/, build/, .next/, target/
- caches and leftovers under /tmp
- stale git worktrees you created (git worktree remove)
Keep source files, uncommitted changes, and memory. Do not delete those without asking the user.`;
}

export function formatLowDiskSpaceReminder(
  level: Exclude<DiskPressureLevel, "ok">,
  sample: DiskSpaceSample,
): string {
  return `${SYSTEM_REMINDER_OPEN}
${formatDiskSpaceGuidance(level, sample)}
${SYSTEM_REMINDER_CLOSE}`;
}
