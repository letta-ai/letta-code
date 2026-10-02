/**
 * Process-level low-disk monitor for managed Cloud sandboxes.
 *
 * Every Letta Code process sharing a sandbox (the TUI, headless sessions, the
 * websocket listener, and each subagent child) runs one of these against the
 * same disk. It checks on activity (each model request and tool batch) and on
 * a 30s timer that runs only while a tool batch or subagent is in flight.
 *
 * Delivery mirrors task notifications. When this process has a queue consumer
 * (TUI, bidirectional headless, listener), alerts are queued through the
 * message-queue bridge, which wakes an idle loop. Headless one-shot processes,
 * which include subagents, have no consumer, so the alert is held and appended
 * to the next model request as a user-role system reminder.
 */
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";
import {
  advanceDiskPressure,
  createDiskPressureState,
  type DiskPressureLevel,
  type DiskSpaceSample,
  formatDiskSpaceGuidance,
  formatDiskSpaceSummary,
  formatLowDiskSpaceReminder,
  measureDiskSpace,
  type StatfsFn,
} from "@/reminders/disk-space";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import {
  addToMessageQueue,
  isQueueBridgeConnected,
  type QueuedMessage,
} from "@/utils/message-queue-bridge";
import {
  formatHarnessEventNotification,
  type NotificationScope,
  resolveNotificationScope,
} from "@/utils/task-notifications";

export const DISK_MONITOR_POLL_INTERVAL_MS = 30_000;
/** At most one statfs per this window, however busy the loops are. */
export const DISK_MONITOR_MIN_CHECK_INTERVAL_MS = 5_000;
/** A request never waits longer than this for a disk measurement. */
export const DISK_MONITOR_REQUEST_WAIT_MS = 250;
/** Idle conversations that sent a request this recently still get alerts. */
export const DISK_MONITOR_RECENT_SCOPE_MS = 30 * 60_000;

export interface DiskSpaceActivityScope {
  agentId?: string | null;
  conversationId?: string | null;
}

export interface DiskSpaceRequestReminder {
  text: string;
  /** Call after the request was accepted; a rejected send keeps the alert. */
  commit: () => void;
}

export interface DiskSpaceMonitorDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  getWorkingDirectory: () => string;
  statfsFn?: StatfsFn;
  isQueueConnected: () => boolean;
  enqueue: (message: QueuedMessage) => void;
  resolveFallbackScope: () => NotificationScope | undefined;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export interface DiskSpaceMonitor {
  /** Hold while work that can fill the disk runs; returns an idempotent release. */
  beginActivity: (scope?: DiskSpaceActivityScope) => () => void;
  /** Debounced immediate check; resolves when it settles. Never rejects. */
  noteActivity: (scope?: DiskSpaceActivityScope) => Promise<void>;
  /** Check, then return any alert held for the next model request. */
  prepareRequestReminder: (
    scope: DiskSpaceActivityScope,
  ) => Promise<DiskSpaceRequestReminder | null>;
  isPolling: () => boolean;
  whenIdle: () => Promise<void>;
}

interface ScopeEntry {
  scope: NotificationScope;
  leases: number;
  lastSeenMs: number;
}

function scopeKey(scope: DiskSpaceActivityScope): string | null {
  if (!scope.agentId) return null;
  return `${scope.agentId}\u0000${scope.conversationId || "default"}`;
}

function defaultDeps(): DiskSpaceMonitorDeps {
  return {
    env: process.env,
    now: Date.now,
    getWorkingDirectory: getCurrentWorkingDirectory,
    isQueueConnected: isQueueBridgeConnected,
    enqueue: addToMessageQueue,
    resolveFallbackScope: () => resolveNotificationScope(),
    setInterval: (fn, ms) => {
      const handle = setInterval(fn, ms);
      // Never keep a finished process alive just to watch the disk.
      handle.unref?.();
      return handle;
    },
    clearInterval: (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

export function createDiskSpaceMonitor(
  overrides: Partial<DiskSpaceMonitorDeps> = {},
): DiskSpaceMonitor {
  const deps: DiskSpaceMonitorDeps = { ...defaultDeps(), ...overrides };
  let pressure = createDiskPressureState();
  let lastCheckStartedAtMs = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let leases = 0;
  let timer: unknown = null;
  let held: { id: number; text: string } | null = null;
  let nextAlertId = 1;
  const scopes = new Map<string, ScopeEntry>();

  const enabled = () => isManagedCloudRuntime(deps.env);

  function rememberScope(scope: DiskSpaceActivityScope | undefined): void {
    const key = scope ? scopeKey(scope) : null;
    if (!key || !scope?.agentId) return;
    const existing = scopes.get(key);
    if (existing) {
      existing.lastSeenMs = deps.now();
      return;
    }
    scopes.set(key, {
      scope: {
        agentId: scope.agentId,
        conversationId: scope.conversationId || "default",
      },
      leases: 0,
      lastSeenMs: deps.now(),
    });
  }

  function targetScopes(): NotificationScope[] {
    const nowMs = deps.now();
    const targets: NotificationScope[] = [];
    for (const [key, entry] of scopes) {
      if (
        entry.leases > 0 ||
        nowMs - entry.lastSeenMs <= DISK_MONITOR_RECENT_SCOPE_MS
      ) {
        targets.push(entry.scope);
      } else {
        scopes.delete(key);
      }
    }
    return targets;
  }

  function deliver(
    level: Exclude<DiskPressureLevel, "ok">,
    sample: DiskSpaceSample,
  ): void {
    const hold = () => {
      // Newest alert wins: a critical supersedes an undelivered warning.
      held = {
        id: nextAlertId++,
        text: formatLowDiskSpaceReminder(level, sample),
      };
    };
    if (!deps.isQueueConnected()) {
      hold();
      return;
    }
    const text = formatHarnessEventNotification({
      taskId: "disk-space",
      summary: formatDiskSpaceSummary(level, sample),
      result: formatDiskSpaceGuidance(level, sample),
    });
    const targets = targetScopes();
    if (targets.length === 0) {
      const fallback = deps.resolveFallbackScope();
      // Consumers such as the listener drop unscoped queue items, so an alert
      // with no known conversation waits for the next model request instead.
      if (!fallback?.agentId) {
        hold();
        return;
      }
      deps.enqueue({ kind: "task_notification", text, ...fallback });
      return;
    }
    for (const scope of targets) {
      deps.enqueue({ kind: "task_notification", text, ...scope });
    }
  }

  function check(): Promise<void> {
    if (!enabled()) return Promise.resolve();
    if (inFlight) return inFlight;
    const nowMs = deps.now();
    if (nowMs - lastCheckStartedAtMs < DISK_MONITOR_MIN_CHECK_INTERVAL_MS) {
      return Promise.resolve();
    }
    lastCheckStartedAtMs = nowMs;
    const run = (async () => {
      try {
        const sample = await measureDiskSpace(
          deps.getWorkingDirectory(),
          deps.statfsFn,
        );
        const next = advanceDiskPressure(pressure, sample);
        pressure = next.state;
        if (next.fire) deliver(next.fire, sample);
      } catch {
        // A failed measurement keeps the previous state; the next one retries.
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  }

  function startTimer(): void {
    if (timer !== null) return;
    timer = deps.setInterval(() => {
      void check();
    }, DISK_MONITOR_POLL_INTERVAL_MS);
  }

  function stopTimer(): void {
    if (timer === null) return;
    deps.clearInterval(timer);
    timer = null;
  }

  return {
    beginActivity(scope) {
      if (!enabled()) return () => {};
      rememberScope(scope);
      const key = scope ? scopeKey(scope) : null;
      const entry = key ? scopes.get(key) : undefined;
      if (entry) entry.leases += 1;
      leases += 1;
      startTimer();
      void check();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (entry) {
          entry.leases -= 1;
          entry.lastSeenMs = deps.now();
        }
        leases -= 1;
        if (leases <= 0) {
          leases = 0;
          stopTimer();
        }
      };
    },
    noteActivity(scope) {
      if (!enabled()) return Promise.resolve();
      rememberScope(scope);
      return check();
    },
    async prepareRequestReminder(scope) {
      if (!enabled()) return null;
      rememberScope(scope);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        check(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, DISK_MONITOR_REQUEST_WAIT_MS);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      const alert = held;
      if (!alert) return null;
      return {
        text: alert.text,
        commit: () => {
          if (held?.id === alert.id) held = null;
        },
      };
    },
    isPolling: () => timer !== null,
    whenIdle: async () => {
      await inFlight;
    },
  };
}

let processMonitor: DiskSpaceMonitor | null = null;

function getProcessMonitor(): DiskSpaceMonitor {
  processMonitor ??= createDiskSpaceMonitor();
  return processMonitor;
}

export function beginDiskSpaceActivity(
  scope?: DiskSpaceActivityScope,
): () => void {
  try {
    return getProcessMonitor().beginActivity(scope);
  } catch {
    return () => {};
  }
}

export function noteDiskSpaceActivity(scope?: DiskSpaceActivityScope): void {
  try {
    void getProcessMonitor().noteActivity(scope);
  } catch {
    // Disk monitoring must never break a turn.
  }
}

export async function prepareDiskSpaceReminderForRequest(
  scope: DiskSpaceActivityScope,
): Promise<DiskSpaceRequestReminder | null> {
  try {
    return await getProcessMonitor().prepareRequestReminder(scope);
  } catch {
    return null;
  }
}

export function setDiskSpaceMonitorForTests(
  monitor: DiskSpaceMonitor | null,
): void {
  processMonitor = monitor;
}
