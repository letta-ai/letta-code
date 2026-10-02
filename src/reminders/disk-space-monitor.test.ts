import { describe, expect, test } from "bun:test";
import {
  createDiskSpaceMonitor,
  DISK_MONITOR_MIN_CHECK_INTERVAL_MS,
  DISK_MONITOR_POLL_INTERVAL_MS,
} from "@/reminders/disk-space-monitor";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

const GIB = 1024 ** 3;
const SANDBOX_ENV = { LETTA_MANAGED_CLOUD_RUNTIME: "1" };

/** A fake disk whose usage the test moves, plus a manual interval clock. */
function createHarness(
  options: { bridgeConnected?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const disk = { usedPercent: 50, totalBytes: 100 * GIB };
  let nowMs = 1_000_000;
  const statfsCalls: string[] = [];
  const queued: QueuedMessage[] = [];
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let nextIntervalId = 1;
  const monitor = createDiskSpaceMonitor({
    env: options.env ?? SANDBOX_ENV,
    now: () => nowMs,
    getWorkingDirectory: () => "/work",
    statfsFn: async (path: string) => {
      statfsCalls.push(path);
      const bsize = 1024;
      const blocks = disk.totalBytes / bsize;
      return {
        bsize,
        blocks,
        bavail: Math.floor(blocks * (1 - disk.usedPercent / 100)),
      };
    },
    isQueueConnected: () => options.bridgeConnected ?? true,
    enqueue: (message) => queued.push(message),
    resolveFallbackScope: () => undefined,
    setInterval: (fn, ms) => {
      const id = nextIntervalId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (handle) => {
      intervals.delete(handle as number);
    },
  });
  return {
    disk,
    monitor,
    queued,
    statfsCalls,
    intervals,
    advance(ms: number) {
      nowMs += ms;
    },
    async tick() {
      nowMs += DISK_MONITOR_POLL_INTERVAL_MS;
      for (const interval of [...intervals.values()]) interval.fn();
      await monitor.whenIdle();
    },
  };
}

describe("createDiskSpaceMonitor", () => {
  test("polls on a 30s timer only while an activity lease is held", async () => {
    const h = createHarness();
    expect(h.monitor.isPolling()).toBe(false);
    expect(h.intervals.size).toBe(0);

    const release = h.monitor.beginActivity({
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
    expect(h.monitor.isPolling()).toBe(true);
    expect([...h.intervals.values()].map((i) => i.ms)).toEqual([
      DISK_MONITOR_POLL_INTERVAL_MS,
    ]);
    const nested = h.monitor.beginActivity();
    expect(h.intervals.size).toBe(1);

    release();
    release(); // idempotent
    expect(h.monitor.isPolling()).toBe(true);
    nested();
    expect(h.monitor.isPolling()).toBe(false);
    expect(h.intervals.size).toBe(0);
  });

  test("never polls outside managed Cloud sandboxes", async () => {
    const h = createHarness({ env: {} });
    const release = h.monitor.beginActivity();
    h.disk.usedPercent = 99;
    await h.monitor.noteActivity();
    expect(h.monitor.isPolling()).toBe(false);
    expect(h.statfsCalls).toEqual([]);
    expect(h.queued).toEqual([]);
    release();
  });

  test("debounces activity checks to one statfs per 5s", async () => {
    const h = createHarness();
    await h.monitor.noteActivity();
    await h.monitor.noteActivity();
    expect(h.statfsCalls).toHaveLength(1);
    h.advance(DISK_MONITOR_MIN_CHECK_INTERVAL_MS);
    await h.monitor.noteActivity();
    expect(h.statfsCalls).toHaveLength(2);
  });

  test("an idle parent gets a queued task notification while its subagent fills the disk", async () => {
    const h = createHarness({ bridgeConnected: true });
    // The parent turn ended; only its background subagent keeps the lease.
    await h.monitor.noteActivity({
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
    const releaseSubagent = h.monitor.beginActivity({
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
    await h.monitor.whenIdle();
    expect(h.queued).toEqual([]);

    h.disk.usedPercent = 88;
    await h.tick();
    expect(h.queued).toHaveLength(1);
    expect(h.queued[0]).toMatchObject({
      kind: "task_notification",
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
    expect(h.queued[0]?.text).toContain("<task-notification>");
    expect(h.queued[0]?.text).toContain("88% full");
    expect(h.queued[0]?.text).toContain("node_modules");
    expect(h.queued[0]?.text).toContain("_cacache");

    await h.tick();
    expect(h.queued).toHaveLength(1);

    h.disk.usedPercent = 100;
    await h.tick();
    expect(h.queued).toHaveLength(2);
    expect(h.queued[1]?.text).toContain("CRITICAL");

    releaseSubagent();
    expect(h.monitor.isPolling()).toBe(false);
  });

  test("fans out to every active scope once", async () => {
    const h = createHarness({ bridgeConnected: true });
    const a = h.monitor.beginActivity({
      agentId: "agent-a",
      conversationId: "conv-a",
    });
    const a2 = h.monitor.beginActivity({
      agentId: "agent-a",
      conversationId: "conv-a",
    });
    const b = h.monitor.beginActivity({
      agentId: "agent-b",
      conversationId: "default",
    });
    await h.monitor.whenIdle();
    h.disk.usedPercent = 90;
    await h.tick();
    expect(
      h.queued.map((message) => [message.agentId, message.conversationId]),
    ).toEqual([
      ["agent-a", "conv-a"],
      ["agent-b", "default"],
    ]);
    a();
    a2();
    b();
  });

  test("without a queue consumer the warning waits for the next model request", async () => {
    const h = createHarness({ bridgeConnected: false });
    const release = h.monitor.beginActivity();
    await h.monitor.whenIdle();
    h.disk.usedPercent = 87;
    await h.tick();
    expect(h.queued).toEqual([]);

    const first = await h.monitor.prepareRequestReminder({
      conversationId: "conv-child",
    });
    expect(first?.text).toContain("<system-reminder>");
    expect(first?.text).toContain("87% full");
    // Not committed (request failed): it must still be delivered next time.
    const retry = await h.monitor.prepareRequestReminder({
      conversationId: "conv-child",
    });
    expect(retry?.text).toBe(first?.text);
    retry?.commit();
    expect(
      await h.monitor.prepareRequestReminder({ conversationId: "conv-child" }),
    ).toBeNull();
    release();
  });

  test("with a consumer but no known scope, the alert is held instead of dropped", async () => {
    const h = createHarness({ bridgeConnected: true });
    const release = h.monitor.beginActivity();
    await h.monitor.whenIdle();
    h.disk.usedPercent = 90;
    await h.tick();
    // An unscoped queue item would be discarded by the listener.
    expect(h.queued).toEqual([]);
    const pending = await h.monitor.prepareRequestReminder({
      agentId: "agent-x",
      conversationId: "conv-x",
    });
    expect(pending?.text).toContain("90% full");
    release();
  });

  test("warning and critical each fire once and re-arm only after usage drops", async () => {
    const h = createHarness({ bridgeConnected: true });
    const release = h.monitor.beginActivity({
      agentId: "agent-a",
      conversationId: "conv-a",
    });
    await h.monitor.whenIdle();
    const levels = () =>
      h.queued.map((m) => (m.text.includes("CRITICAL") ? "critical" : "warn"));
    for (const percent of [86, 90, 96, 99, 92, 96, 87, 96, 70, 88]) {
      h.disk.usedPercent = percent;
      await h.tick();
    }
    // 86 warns, 96 escalates, 92 and the next 96 stay quiet (still above the
    // critical re-arm mark). 87 re-arms only critical, so the following 96
    // fires it again; 70 re-arms the warning, and 88 warns again.
    expect(levels()).toEqual(["warn", "critical", "critical", "warn"]);
    release();
  });

  test("a critical alert supersedes an undelivered warning", async () => {
    const h = createHarness({ bridgeConnected: false });
    const release = h.monitor.beginActivity();
    await h.monitor.whenIdle();
    h.disk.usedPercent = 87;
    await h.tick();
    h.disk.usedPercent = 97;
    await h.tick();
    const pending = await h.monitor.prepareRequestReminder({
      conversationId: "c",
    });
    expect(pending?.text).toContain("CRITICAL");
    expect(pending?.text).not.toContain("LOW DISK SPACE WARNING");
    release();
  });

  test("statfs failures never throw into the caller", async () => {
    const queued: QueuedMessage[] = [];
    const monitor = createDiskSpaceMonitor({
      env: SANDBOX_ENV,
      statfsFn: async () => {
        throw new Error("EIO");
      },
      isQueueConnected: () => true,
      enqueue: (message) => queued.push(message),
      setInterval: () => 1,
      clearInterval: () => {},
    });
    await monitor.noteActivity();
    expect(
      await monitor.prepareRequestReminder({ conversationId: "c" }),
    ).toBeNull();
    expect(queued).toEqual([]);
  });
});
