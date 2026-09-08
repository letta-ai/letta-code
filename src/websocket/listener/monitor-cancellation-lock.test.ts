import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type MonitorCancellationReceipt,
  MonitorCancellationStore,
} from "@/tools/impl/monitor-cancellation-store";
import { MonitorCancellationDelivery } from "./monitor-cancellation-delivery";

let directory: string;
let store: MonitorCancellationStore;
const receipt: MonitorCancellationReceipt = {
  version: 1,
  processId: "monitor-1",
  noticeId: "notice-1",
  description: "CI results",
  runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
  state: "stopped",
  createdAt: 1,
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "monitor-owner-"));
  store = new MonitorCancellationStore(directory);
  store.write(receipt);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function delivery() {
  let queued = false;
  let persisted = false;
  const sent: string[] = [];
  const errors: unknown[] = [];
  return {
    sent,
    errors,
    accept: () => {
      persisted = true;
    },
    instance: new MonitorCancellationDelivery(
      new MonitorCancellationStore(directory),
      {
        wasPersisted: async () => persisted,
        isPending: () => queued,
        isRunning: () => false,
        enqueue: (row) => {
          sent.push(row.noticeId);
          queued = true;
          return true;
        },
        onError: (error) => errors.push(error),
      },
    ),
  };
}

test("independent live listeners hold one delivery owner through persistence", async () => {
  const a = delivery();
  const b = delivery();
  await Promise.all([a.instance.pump(), b.instance.pump()]);
  expect([...a.sent, ...b.sent]).toEqual([receipt.noticeId]);
  await Promise.all([a.instance.pump(), b.instance.pump()]);
  expect([...a.sent, ...b.sent]).toEqual([receipt.noticeId]);
  expect(store.read(receipt.processId)?.state).toBe("stopped");
  const holder = a.sent.length ? a : b;
  const other = a.sent.length ? b : a;
  holder.accept();
  await holder.instance.pump();
  await other.instance.pump();
  expect(store.read(receipt.processId)?.state).toBe("delivered");
  expect([...a.sent, ...b.sent]).toEqual([receipt.noticeId]);
});

test("a live holder cannot be replaced on service disposal", async () => {
  const holder = delivery();
  await holder.instance.pump();
  holder.instance.dispose();
  const other = delivery();
  await other.instance.pump();
  expect(other.sent).toEqual([]);
});

test("does not recover a cancellation intent while its writer process is alive", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      "console.log('writer-ready'); setInterval(() => {}, 1000)",
    ],
    { stdout: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    await reader.read();
    reader.releaseLock();
    store.write({ ...receipt, state: "intent", creatorPid: child.pid });
    const next = delivery();
    await next.instance.pump();
    expect(next.sent).toEqual([]);
    expect(store.read(receipt.processId)?.state).toBe("intent");
    child.kill();
    await child.exited;
    await next.instance.pump();
    expect(next.sent).toEqual([receipt.noticeId]);
    expect(store.read(receipt.processId)?.state).toBe("uncertain");
  } finally {
    child.kill();
    await child.exited;
  }
}, 10_000);

test("after the owner process exits, only one listener takes over its pending notice", async () => {
  const modulePath = fileURLToPath(
    new URL("./monitor-cancellation-lock.ts", import.meta.url),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { acquireMonitorCancellationOwner } from ${JSON.stringify(modulePath)};
     await acquireMonitorCancellationOwner(${JSON.stringify(directory)}, ${JSON.stringify(receipt)});
     console.log('owner-ready'); setInterval(() => {}, 1000);`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("owner-ready");
    const a = delivery();
    const b = delivery();
    await Promise.all([a.instance.pump(), b.instance.pump()]);
    expect([...a.sent, ...b.sent]).toEqual([]);
    child.kill();
    await child.exited;
    await Promise.all([a.instance.pump(), b.instance.pump()]);
    expect([...a.sent, ...b.sent]).toEqual([receipt.noticeId]);
    expect(store.read(receipt.processId)?.noticeId).toBe(receipt.noticeId);
  } finally {
    child.kill();
    await child.exited;
  }
}, 10_000);
