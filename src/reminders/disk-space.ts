import { statfs } from "node:fs/promises";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";

/** Warn when at least this fraction of the volume is used... */
export const LOW_DISK_USED_FRACTION = 0.9;
/** ...or when less than this many bytes remain available. */
export const LOW_DISK_AVAILABLE_BYTES = 1024 ** 3;
/** Minimum time between disk measurements. */
export const DISK_SPACE_CHECK_INTERVAL_MS = 60_000;

export interface DiskSpaceSample {
  path: string;
  totalBytes: number;
  availableBytes: number;
}

type StatfsFn = (path: string) => Promise<{
  bsize: number;
  blocks: number;
  bavail: number;
}>;

interface DiskSpaceCache {
  sample: DiskSpaceSample | null;
  lastCheckStartedAtMs: number;
  inFlight: boolean;
}

const cache: DiskSpaceCache = {
  sample: null,
  lastCheckStartedAtMs: Number.NEGATIVE_INFINITY,
  inFlight: false,
};

export function isDiskSpaceLow(sample: DiskSpaceSample): boolean {
  if (sample.totalBytes <= 0) return false;
  const usedFraction = 1 - sample.availableBytes / sample.totalBytes;
  return (
    usedFraction >= LOW_DISK_USED_FRACTION ||
    sample.availableBytes < LOW_DISK_AVAILABLE_BYTES
  );
}

/**
 * Start a background measurement if the last one is old enough. Never awaits
 * and never throws: a failed measurement leaves the previous sample in place.
 */
export function refreshDiskSpaceSample(
  path: string,
  options: { nowMs?: number; statfsFn?: StatfsFn } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  if (cache.inFlight) return;
  if (nowMs - cache.lastCheckStartedAtMs < DISK_SPACE_CHECK_INTERVAL_MS) {
    return;
  }
  cache.inFlight = true;
  cache.lastCheckStartedAtMs = nowMs;
  const statfsFn = options.statfsFn ?? statfs;
  let pending: Promise<unknown>;
  try {
    pending = statfsFn(path).then((stats) => {
      cache.sample = {
        path,
        totalBytes: stats.blocks * stats.bsize,
        availableBytes: stats.bavail * stats.bsize,
      };
    });
  } catch {
    cache.inFlight = false;
    return;
  }
  void pending
    .catch(() => {})
    .finally(() => {
      cache.inFlight = false;
    });
}

export function getCachedDiskSpaceSample(): DiskSpaceSample | null {
  return cache.sample;
}

export function resetDiskSpaceCacheForTests(): void {
  cache.sample = null;
  cache.lastCheckStartedAtMs = Number.NEGATIVE_INFINITY;
  cache.inFlight = false;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

export function formatLowDiskSpaceReminder(sample: DiskSpaceSample): string {
  const usedPercent = Math.round(
    (1 - sample.availableBytes / sample.totalBytes) * 100,
  );
  return `${SYSTEM_REMINDER_OPEN}
LOW DISK SPACE: The sandbox volume holding ${sample.path} is ${usedPercent}% full (${formatBytes(sample.availableBytes)} available of ${formatBytes(sample.totalBytes)}). When it fills, file writes, installs, builds, and memory git commits start failing.

Before continuing with disk-heavy work, free space: use \`du -xh --max-depth=2 <dir> | sort -h\` to find large directories, then delete regenerable data such as package manager caches, build outputs, old worktrees you created, and temporary files. Do not delete the user's source files, uncommitted work, or memory without asking.
${SYSTEM_REMINDER_CLOSE}`;
}

export interface DiskSpaceReminderInput {
  workingDirectory: string;
  /** Per-conversation flag: true once the current low-disk episode was reported. */
  notified: boolean;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  statfsFn?: StatfsFn;
}

/**
 * Fire-and-forget low-disk check for managed Cloud sandboxes. The turn never
 * waits on the filesystem: it reads the last cached sample and schedules a
 * fresh one for a later turn. Reports once per low-disk episode.
 */
export function evaluateDiskSpaceReminder(input: DiskSpaceReminderInput): {
  text: string | null;
  notified: boolean;
} {
  try {
    if (!isManagedCloudRuntime(input.env)) {
      return { text: null, notified: input.notified };
    }
    refreshDiskSpaceSample(input.workingDirectory, {
      nowMs: input.nowMs,
      statfsFn: input.statfsFn,
    });
    const sample = getCachedDiskSpaceSample();
    if (!sample) return { text: null, notified: input.notified };
    if (!isDiskSpaceLow(sample)) return { text: null, notified: false };
    if (input.notified) return { text: null, notified: true };
    return { text: formatLowDiskSpaceReminder(sample), notified: true };
  } catch {
    return { text: null, notified: input.notified };
  }
}
