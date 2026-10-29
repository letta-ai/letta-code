import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  dispositionKey,
  getInputDisposition,
  inputDispositionPersistentPath,
  loadDurableQueuedInputs,
  ordinaryInputIdentity,
  rememberInputDisposition,
  reserveInputDisposition,
} from "./input-disposition";
import {
  hasLiveAcceptedInputOwner,
  hasLiveAcceptedInputOwnerWithOriginatorRetirement,
} from "./input-disposition-ownership";
import { completeInputReplay } from "./input-terminal-journal";
import { createRuntime } from "./lifecycle";
import type { IncomingMessage } from "./types";

function durableIncoming(clientMessageId: string): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-durable",
    conversationId: "conversation-durable",
    messages: [
      {
        role: "user",
        content: clientMessageId,
        client_message_id: clientMessageId,
      },
    ],
  };
}

test("durable input ledgers are isolated by backend URL", () => {
  const cloud = inputDispositionPersistentPath("https://api.letta.com");
  const local = inputDispositionPersistentPath("http://localhost:8283");
  expect(cloud).not.toBe(local);
  expect(cloud.endsWith("input-dispositions-v2.json")).toBe(true);
  expect(local.endsWith("input-dispositions-v2.json")).toBe(true);
});

function persistentRuntime(path: string) {
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: path });
  return getOrCreateScopedRuntime(
    listener,
    "agent-durable",
    "conversation-durable",
  );
}

test("terminal completion cannot retire another queued input through correlation", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-foreign-"));
  try {
    const runtime = persistentRuntime(join(root, "state.json"));
    const queued = ordinaryInputIdentity("cm-queued-a");
    const started = ordinaryInputIdentity("cm-started-b");
    if (!queued || !started) throw new Error("expected stable identities");
    expect(
      rememberInputDisposition(runtime, queued, "queued", {
        incoming: durableIncoming("cm-queued-a"),
      }),
    ).toBe(true);
    expect(
      rememberInputDisposition(runtime, started, "started", {
        incoming: {
          ...durableIncoming("cm-started-b"),
          messages: [
            {
              role: "user",
              content: "B references A as a secondary correlation only",
              client_message_id: "cm-started-b",
            },
            {
              role: "user",
              content: "secondary",
              client_message_id: "cm-queued-a",
            },
          ],
        },
      }),
    ).toBe(true);

    expect(completeInputReplay(runtime, [started, queued])).toBe(false);
    expect(loadDurableQueuedInputs(runtime.listener)).toHaveLength(2);
    expect(completeInputReplay(runtime, [started])).toBe(true);
    expect(loadDurableQueuedInputs(runtime.listener)).toEqual([
      expect.objectContaining({ identity: queued }),
    ]);
    expect(getInputDisposition(runtime, queued)).toBe("queued");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hasLiveAcceptedInputOwner: live started/queued owners qualify, terminal tombstones do not", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const startedId = ordinaryInputIdentity("live-started");
  const queuedId = ordinaryInputIdentity("live-queued");

  // Unknown identity: no owner at all.
  expect(
    hasLiveAcceptedInputOwner(runtime, ordinaryInputIdentity("unknown")),
  ).toBe(false);
  expect(hasLiveAcceptedInputOwner(runtime, undefined)).toBe(false);

  // Started owner: live.
  const startedAdmission = reserveInputDisposition(runtime, startedId);
  expect(startedAdmission.kind).toBe("reserved");
  if (startedAdmission.kind !== "reserved") return;
  commitInputDisposition(runtime, startedAdmission.reservation, "started", {
    incoming: {
      type: "message",
      agentId: "agent-1",
      conversationId: "conversation-1",
      messages: [],
    },
  });
  expect(hasLiveAcceptedInputOwner(runtime, startedId)).toBe(true);

  // Queued owner: live.
  const queuedAdmission = reserveInputDisposition(runtime, queuedId);
  expect(queuedAdmission.kind).toBe("reserved");
  if (queuedAdmission.kind !== "reserved") return;
  commitInputDisposition(runtime, queuedAdmission.reservation, "queued", {
    incoming: {
      type: "message",
      agentId: "agent-1",
      conversationId: "conversation-1",
      messages: [],
    },
  });
  expect(hasLiveAcceptedInputOwner(runtime, queuedId)).toBe(true);

  // Replay-completed (terminal-retired) disposition: NOT live, even though
  // the entry itself persists as a tombstone.
  completeInputReplay(runtime, startedId ? [startedId] : []);
  expect(getInputDisposition(runtime, startedId)).toBeDefined();
  expect(hasLiveAcceptedInputOwner(runtime, startedId)).toBe(false);

  // Terminal-prepared disposition: NOT live.
  if (!queuedId) return;
  const preparedKey = dispositionKey(runtime.key, queuedId);
  const preparedEntry =
    listener.acceptedInputDispositionLedger.entries.get(preparedKey);
  expect(preparedEntry).toBeDefined();
  if (preparedEntry) {
    preparedEntry.preparedTerminal = {
      stopReason: "end_turn",
    } as never;
    expect(hasLiveAcceptedInputOwner(runtime, queuedId)).toBe(false);
  }

  // Expired entry: NOT live.
  const expiredId = ordinaryInputIdentity("expired");
  const expiredAdmission = reserveInputDisposition(runtime, expiredId);
  expect(expiredAdmission.kind).toBe("reserved");
  if (expiredAdmission.kind !== "reserved") return;
  commitInputDisposition(runtime, expiredAdmission.reservation, "started", {
    incoming: {
      type: "message",
      agentId: "agent-1",
      conversationId: "conversation-1",
      messages: [],
    },
  });
  if (!expiredId) return;
  const expiredKey = dispositionKey(runtime.key, expiredId);
  const expiredEntry =
    listener.acceptedInputDispositionLedger.entries.get(expiredKey);
  expect(expiredEntry).toBeDefined();
  if (expiredEntry) {
    expiredEntry.expiresAt = Date.now() - 1;
    expect(hasLiveAcceptedInputOwner(runtime, expiredId)).toBe(false);
  }
});

test("originator retirement proof: pre-owner-id records fail closed (evil-shub round 5 P2)", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );

  // New-format record: the persisted continuation carries the owner id, so
  // its replayed finalizer can retire a recreated token entry.
  const newFormatId = ordinaryInputIdentity("new-format");
  expect(
    rememberInputDisposition(runtime, newFormatId, "started", {
      incoming: {
        ...durableIncoming("new-format"),
        mcpOriginatorSuperRunId: "run-new",
      },
    }),
  ).toBe(true);
  expect(hasLiveAcceptedInputOwner(runtime, newFormatId)).toBe(true);
  expect(
    hasLiveAcceptedInputOwnerWithOriginatorRetirement(runtime, newFormatId),
  ).toBe(true);

  // Old-format record (650eb75f): live owner, but no durable owner id —
  // replaying it could never retire a recreated token, so recreation must
  // fail closed (the continuation runs headerless instead).
  const oldFormatId = ordinaryInputIdentity("old-format");
  expect(
    rememberInputDisposition(runtime, oldFormatId, "started", {
      incoming: durableIncoming("old-format"),
    }),
  ).toBe(true);
  expect(hasLiveAcceptedInputOwner(runtime, oldFormatId)).toBe(true);
  expect(
    hasLiveAcceptedInputOwnerWithOriginatorRetirement(runtime, oldFormatId),
  ).toBe(false);

  // Unknown identity: neither proof qualifies.
  const unknownId = ordinaryInputIdentity("unknown");
  expect(
    hasLiveAcceptedInputOwnerWithOriginatorRetirement(runtime, unknownId),
  ).toBe(false);
});
