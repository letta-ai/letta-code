import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateScopedRuntime,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  dispositionKey,
  getInputDisposition,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { completeInputReplay } from "./input-terminal-journal";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";

function runtimeAt(path: string) {
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: path });
  return getOrCreateScopedRuntime(listener, "agent-test", "conversation-test");
}

function restoreStarted(path: string) {
  const original = runtimeAt(path);
  const identity = ordinaryInputIdentity("input-test");
  if (!identity) throw new Error("missing identity");
  const admission = reserveInputDisposition(original, identity);
  if (admission.kind !== "reserved") throw new Error("expected reservation");
  expect(
    commitInputDisposition(original, admission.reservation, "queued", {
      incoming: {
        type: "message",
        agentId: original.agentId,
        conversationId: original.conversationId,
        messages: [
          {
            role: "user",
            content: "test input",
            client_message_id: identity.id,
          },
        ],
      },
    }),
  ).toBe(true);
  expect(restoreDurableQueuedInputs(original.listener)).toBe(1);
  expect(consumeQueuedTurn(original)).not.toBeNull();
  const restarted = runtimeAt(path);
  expect(restoreDurableQueuedInputs(restarted.listener)).toBe(1);
  const item = restarted.queueRuntime.peek()[0];
  if (!item) throw new Error("expected restored item");
  return { original, restarted, identity, item };
}

test("removing a restored item after replay completion retains its durable tombstone", () => {
  const root = mkdtempSync(join(tmpdir(), "completed-queue-removal-"));
  try {
    const path = join(root, "ledger.json");
    const { original, restarted, identity, item } = restoreStarted(path);
    // A terminal writer retires the payload after the receiver restored it.
    expect(completeInputReplay(original, [identity])).toBe(true);
    const terminalLedger = readFileSync(path, "utf8");
    expect(restarted.queueRuntime.removeItem(item.id)).toEqual(item);
    expect(restarted.queueRuntime.length).toBe(0);
    expect(restarted.queuedMessagesByItemId.has(item.id)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(terminalLedger);
    const afterRemoval = runtimeAt(path);
    expect(restoreDurableQueuedInputs(afterRemoval.listener)).toBe(0);
    expect(reserveInputDisposition(afterRemoval, identity)).toEqual({
      kind: "duplicate",
      disposition: "started",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  "corrupt",
  "missing-marker",
  "missing-file",
  "missing-entry",
] as const)(
  "%s ledger refuses removal even when memory contains completed evidence",
  (damage) => {
    const root = mkdtempSync(join(tmpdir(), "invalid-queue-removal-"));
    try {
      const path = join(root, "ledger.json");
      const { restarted, identity, item } = restoreStarted(path);
      expect(completeInputReplay(restarted, [identity])).toBe(true);
      if (damage === "missing-file") rmSync(path);
      else if (damage === "corrupt") writeFileSync(path, "{broken");
      else {
        const store = JSON.parse(readFileSync(path, "utf8"));
        const key = dispositionKey(restarted.key, identity);
        if (damage === "missing-entry") delete store.entries[key];
        else delete store.entries[key].replayCompleted;
        writeFileSync(path, JSON.stringify(store));
      }
      expect(restarted.queueRuntime.removeItem(item.id)).toBeNull();
      expect(restarted.queueRuntime.peek()).toEqual([item]);
      expect(restarted.queuedMessagesByItemId.has(item.id)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("an active started payload survives restart and restored cancellation still works", () => {
  const root = mkdtempSync(join(tmpdir(), "active-queue-removal-"));
  try {
    const path = join(root, "ledger.json");
    const { original, restarted, identity, item } = restoreStarted(path);
    expect(restoreDurableQueuedInputs(original.listener)).toBe(0);
    expect(original.queueRuntime.removeItem(item.id)).toBeNull();
    expect(getInputDisposition(original, identity)).toBe("started");
    expect(restarted.queueRuntime.removeItem(item.id)).toEqual(item);
    const afterRemoval = runtimeAt(path);
    expect(restoreDurableQueuedInputs(afterRemoval.listener)).toBe(0);
    expect(reserveInputDisposition(afterRemoval, identity).kind).toBe(
      "reserved",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
