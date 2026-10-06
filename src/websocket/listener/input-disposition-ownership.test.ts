import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createAcceptedInputDispositionLedger,
  getInputDisposition,
  loadDurableQueuedInputs,
  ordinaryInputIdentity,
  rememberInputDisposition,
} from "./input-disposition";
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
