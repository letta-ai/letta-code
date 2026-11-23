import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";
import {
  DiskReserve,
  setDiskReserve,
  updateDiskReserve,
} from "@/utils/disk-reserve";
import {
  addToMessageQueue,
  isQueueBridgeConnected,
} from "@/utils/message-queue-bridge";
import { resolveNotificationScope } from "@/utils/task-notifications";

export const LOW_DISK_USED_FRACTION = 0.9;
export const LOW_DISK_AVAILABLE_BYTES = 1024 ** 3;
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

export const CRITICAL_DISK_USED_FRACTION = 0.95;
export const DISK_SPACE_POLL_INTERVAL_MS = 30_000;

type AlertLevel = 0 | 1 | 2;

function alertLevel(sample: DiskSpaceSample): AlertLevel {
  if (!isDiskSpaceLow(sample)) return 0;
  const usedFraction = 1 - sample.availableBytes / sample.totalBytes;
  return usedFraction >= CRITICAL_DISK_USED_FRACTION ? 2 : 1;
}

let pushedLevel: AlertLevel = 0;

export async function checkDiskSpaceNow(
  path: string,
  options: { env?: NodeJS.ProcessEnv; statfsFn?: StatfsFn } = {},
): Promise<string | null> {
  try {
    if (!isManagedCloudRuntime(options.env)) return null;
    const stats = await (options.statfsFn ?? statfs)(path);
    const sample = {
      path,
      totalBytes: stats.blocks * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
    };
    cache.sample = sample;
    const reserveReleased = updateDiskReserve(sample);
    const level = alertLevel(sample);
    if (level <= pushedLevel) {
      if (level === 0) pushedLevel = 0;
      return null;
    }
    pushedLevel = level;
    return reserveReleased ? null : formatLowDiskSpaceReminder(sample);
  } catch {
    return null;
  }
}

export async function watchDiskSpaceDuring<T>(
  path: string,
  deliver: (reminder: string) => void,
  work: () => Promise<T>,
  options: {
    env?: NodeJS.ProcessEnv;
    statfsFn?: StatfsFn;
    intervalMs?: number;
  } = {},
): Promise<T> {
  if (!isManagedCloudRuntime(options.env) || sandboxPollTimer) return work();
  const check = () =>
    void checkDiskSpaceNow(path, options).then((text) => {
      if (text) deliver(text);
    });
  const timer = setInterval(
    check,
    options.intervalMs ?? DISK_SPACE_POLL_INTERVAL_MS,
  );
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    check();
  }
}

let sandboxPollTimer: ReturnType<typeof setInterval> | null = null;

export function watchSandboxDiskSpace(
  getPath: () => string,
  deliver: (reminder: string) => void,
  options: {
    env?: NodeJS.ProcessEnv;
    statfsFn?: StatfsFn;
    intervalMs?: number;
    reserveDirectory?: string;
  } = {},
): () => void {
  try {
    if (!isManagedCloudRuntime(options.env)) return () => {};
    if (sandboxPollTimer) clearInterval(sandboxPollTimer);
    if (options.reserveDirectory) {
      setDiskReserve(
        new DiskReserve(join(options.reserveDirectory, "disk-reserve"), () => {
          pushedLevel = 2;
          deliver(`${SYSTEM_REMINDER_OPEN}
LOW DISK SPACE: The sandbox disk filled or reached critical usage. The 512 MB emergency reserve has been released and is the only headroom left. Free space now before continuing disk-heavy work. Delete regenerable caches, build outputs, and temporary files; do not delete the user's source files, uncommitted work, or memory without asking.
${SYSTEM_REMINDER_CLOSE}`);
        }),
      );
    }
    const check = () => {
      try {
        void checkDiskSpaceNow(getPath(), options)
          .then((text) => {
            if (text) deliver(text);
          })
          .catch(() => {});
      } catch {}
    };
    check();
    const timer = setInterval(
      check,
      options.intervalMs ?? DISK_SPACE_POLL_INTERVAL_MS,
    );
    timer.unref?.();
    sandboxPollTimer = timer;
    return () => {
      clearInterval(timer);
      if (sandboxPollTimer === timer) {
        sandboxPollTimer = null;
        setDiskReserve(null);
      }
    };
  } catch {
    return () => {};
  }
}

export function isSandboxDiskWatchRunning(): boolean {
  return sandboxPollTimer !== null;
}

let pendingRequestReminder: string | null = null;

export function deliverDiskSpaceReminder(
  text: string,
  parentScope?: { agentId: string; conversationId: string },
): void {
  if (!isQueueBridgeConnected()) {
    pendingRequestReminder = text;
    return;
  }
  addToMessageQueue({
    kind: "task_notification",
    text,
    ...resolveNotificationScope(parentScope),
  });
}

export function takePendingDiskSpaceReminder(): string | null {
  const text = pendingRequestReminder;
  pendingRequestReminder = null;
  return text;
}

export function resetDiskSpaceAlertForTests(): void {
  pushedLevel = 0;
  setDiskReserve(null);
  if (sandboxPollTimer) clearInterval(sandboxPollTimer);
  sandboxPollTimer = null;
  pendingRequestReminder = null;
}

export interface DiskSpaceReminderInput {
  workingDirectory: string;
  notified: boolean;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  statfsFn?: StatfsFn;
}

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
