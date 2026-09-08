import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MonitorCancellationReceipt,
  MonitorCancellationStore,
} from "@/tools/impl/monitor-cancellation-store";
import {
  type CancellationDeliveryDependencies,
  MonitorCancellationDelivery,
} from "./monitor-cancellation-delivery";
import type { MonitorCancellationOwner } from "./monitor-cancellation-lock";

let dir: string;
let store: MonitorCancellationStore;
let owners: Map<string, MonitorCancellationOwner>;
const receipt: MonitorCancellationReceipt = {
  version: 1,
  processId: "monitor-1",
  noticeId: "notice-1",
  description: "CI results",
  runtime: {
    agent_id: "agent-a",
    conversation_id: "conv-a",
    acting_user_id: "user-a",
  },
  state: "stopped",
  createdAt: 1,
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cancel-delivery-"));
  store = new MonitorCancellationStore(dir);
  owners = new Map();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function harness(overrides: Partial<CancellationDeliveryDependencies> = {}) {
  const sent: Array<{ receipt: MonitorCancellationReceipt; text: string }> = [];
  let queued = false;
  let persisted = false;
  const errors: unknown[] = [];
  const deps: CancellationDeliveryDependencies = {
    wasPersisted: async () => persisted,
    isPending: () => queued,
    isRunning: () => false,
    enqueue: (receipt, text) => {
      queued = true;
      sent.push({ receipt, text });
      return true;
    },
    onError: (error) => errors.push(error),
    ...overrides,
  };
  return {
    deps,
    sent,
    errors,
    delivery: new MonitorCancellationDelivery(store, deps, owners),
    finish: () => {
      persisted = true;
      queued = false;
    },
    drop: () => {
      queued = false;
    },
  };
}

describe("Monitor cancellation recovery", () => {
  test("queues the scoped stable notice once, retaining it until persistence", async () => {
    store.write(receipt);
    const h = harness();
    await h.delivery.pump();
    await h.delivery.pump();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.receipt.runtime).toEqual(receipt.runtime);
    expect(h.sent[0]?.text).toContain("Notice ID: notice-1");
    expect(h.sent[0]?.text).toContain("The user cancelled this Monitor");
    expect(store.read(receipt.processId)?.state).toBe("stopped");
    h.finish();
    await h.delivery.pump();
    expect(store.read(receipt.processId)?.state).toBe("delivered");
    await new MonitorCancellationDelivery(
      new MonitorCancellationStore(dir),
      h.deps,
    ).pump();
    expect(h.sent).toHaveLength(1);
  });

  test("reinstalls delivery and checks persisted input before replay", async () => {
    store.write(receipt);
    const h = harness();
    await h.delivery.pump();
    h.delivery.dispose();
    h.finish();
    await new MonitorCancellationDelivery(
      new MonitorCancellationStore(dir),
      h.deps,
      owners,
    ).pump();
    expect(h.sent).toHaveLength(1);
    expect(store.read(receipt.processId)?.state).toBe("delivered");
  });

  test("retains receipt through rejected queue and failed input lookup, replaying same ID", async () => {
    store.write(receipt);
    const rejected = harness({ enqueue: () => false });
    await rejected.delivery.pump();
    expect(store.read(receipt.processId)?.state).toBe("stopped");
    const failed = harness({
      wasPersisted: async () => {
        throw new Error("offline");
      },
    });
    await failed.delivery.pump();
    expect(failed.sent).toEqual([]);
    expect(failed.errors).toHaveLength(1);
    const recovered = harness();
    await recovered.delivery.pump();
    expect(recovered.sent[0]?.receipt.noticeId).toBe(receipt.noticeId);
    recovered.drop();
    await recovered.delivery.pump();
    expect(recovered.sent).toHaveLength(2);
    expect(recovered.sent[1]?.receipt.noticeId).toBe(receipt.noticeId);
  });

  test("at-least-once recovery may repeat an ambiguously accepted notice with the same ID", async () => {
    store.write(receipt);
    const h = harness();
    await h.delivery.pump();
    h.delivery.dispose();
    const restarted = harness(); // acceptance is not yet visible after the crash
    await restarted.delivery.pump();
    expect(restarted.sent[0]?.receipt.noticeId).toBe(
      h.sent[0]?.receipt.noticeId,
    );
  });

  test("an orphaned intent reports uncertainty without inventing a confirmed cancellation", async () => {
    store.write({ ...receipt, state: "intent" });
    const active = harness({ isRunning: () => true });
    await active.delivery.pump();
    expect(active.sent).toEqual([]);
    expect(store.read(receipt.processId)?.state).toBe("intent");
    const restarted = harness();
    await restarted.delivery.pump();
    expect(restarted.sent[0]?.text).toContain(
      "before cancellation was confirmed",
    );
    expect(restarted.sent[0]?.text).not.toContain(
      "The user cancelled this Monitor",
    );
    expect(store.read(receipt.processId)?.state).toBe("uncertain");
  });

  test("failed stops are not delivered and disposal prevents late enqueues", async () => {
    store.write({ ...receipt, state: "failed" });
    const h = harness();
    await h.delivery.pump();
    expect(h.sent).toEqual([]);
    store.write(receipt);
    let resolveLookup!: (persisted: boolean) => void;
    let startLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      startLookup = resolve;
    });
    const delayed = harness({
      wasPersisted: () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
          startLookup();
        }),
    });
    const work = delayed.delivery.pump();
    await lookupStarted;
    delayed.delivery.dispose();
    resolveLookup(false);
    await work;
    expect(delayed.sent).toEqual([]);
    expect(store.read(receipt.processId)?.state).toBe("stopped");
  });
});
