import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateScopedRuntime,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  getInputDisposition,
  MAX_DURABLE_QUEUED_INPUT_BYTES,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { rollbackInputDisposition } from "./input-disposition-rollback";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import type { IncomingMessage } from "./types";

afterEach(() => setActiveRuntime(null));

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

function messageWithContent(
  clientMessageId: string,
  content: IncomingMessage["messages"][number]["content"],
): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-durable",
    conversationId: "conversation-durable",
    messages: [
      { role: "user", content, client_message_id: clientMessageId },
    ] as IncomingMessage["messages"],
  };
}

test("inline base64 image input of ~5 MB is accepted and replayed intact", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-image-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-photo");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    // ~5 MB of base64: the shape chat.letta.com sends for a photo attachment.
    const imageData = Buffer.alloc(3_750_000, 7).toString("base64");
    const photo = messageWithContent("cm-photo", [
      { type: "text", text: "what is in this photo?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: imageData },
      },
    ]);
    expect(
      commitInputDisposition(runtime, admission.reservation, "queued", {
        incoming: photo,
      }),
    ).toBe(true);
    expect(getInputDisposition(runtime, identity)).toBe("queued");

    const restarted = persistentRuntime(path);
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(1);
    const item = restarted.queueRuntime.peek()[0];
    const restored =
      item && restarted.queuedMessagesByItemId.get(item.id)?.messages[0];
    expect(JSON.stringify(restored)).toContain(imageData);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized queued payload is rejected without a queued tombstone", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-size-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-too-large");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    const oversized = messageWithContent(
      "cm-too-large",
      "x".repeat(MAX_DURABLE_QUEUED_INPUT_BYTES + 1),
    );
    expect(
      commitInputDisposition(runtime, admission.reservation, "queued", {
        incoming: oversized,
      }),
    ).toBe(false);
    rollbackInputDisposition(runtime, admission.reservation);
    expect(getInputDisposition(runtime, identity)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
