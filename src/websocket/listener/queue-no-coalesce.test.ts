import { describe, expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";
import type { IncomingMessage } from "./types";

function bridgeMessage(text: string, otid: string): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-1",
    conversationId: "conv-1",
    noCoalesce: true,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text }],
        otid,
        client_message_id: otid,
      },
    ],
  };
}

describe("queue noCoalesce batching", () => {
  test("noCoalesce messages drain as single-item batches with their own OTIDs", () => {
    // Through the REAL queue path (enqueue → consumeQueuedTurn →
    // buildQueuedTurnMessage): without noCoalesce, two same-scope messages
    // merge into one batch that carries only the first request's OTID,
    // which strands the second request's turn correlation.
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    expect(
      enqueueInboundUserMessage(runtime, bridgeMessage("first", "otid-first")),
    ).toBe(true);
    expect(
      enqueueInboundUserMessage(
        runtime,
        bridgeMessage("second", "otid-second"),
      ),
    ).toBe(true);

    const first = consumeQueuedTurn(runtime);
    expect(first?.dequeuedBatch.items).toHaveLength(1);
    expect(first?.queuedTurn.messages).toHaveLength(1);
    expect(first?.queuedTurn.messages[0]).toMatchObject({
      otid: "otid-first",
    });

    const second = consumeQueuedTurn(runtime);
    expect(second?.dequeuedBatch.items).toHaveLength(1);
    expect(second?.queuedTurn.messages[0]).toMatchObject({
      otid: "otid-second",
    });

    expect(consumeQueuedTurn(runtime)).toBeNull();
  });

  test("a noCoalesce message never joins a preceding coalescable batch", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    const plain: IncomingMessage = {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "plain" }],
          otid: "otid-plain",
          client_message_id: "otid-plain",
        },
      ],
    };
    expect(enqueueInboundUserMessage(runtime, plain)).toBe(true);
    expect(
      enqueueInboundUserMessage(
        runtime,
        bridgeMessage("bridge", "otid-bridge"),
      ),
    ).toBe(true);

    const first = consumeQueuedTurn(runtime);
    expect(first?.dequeuedBatch.items).toHaveLength(1);
    expect(first?.queuedTurn.messages[0]).toMatchObject({
      otid: "otid-plain",
    });

    const second = consumeQueuedTurn(runtime);
    expect(second?.dequeuedBatch.items).toHaveLength(1);
    expect(second?.queuedTurn.messages[0]).toMatchObject({
      otid: "otid-bridge",
    });
  });

  test("plain messages still coalesce (existing behavior unchanged)", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    for (const [text, otid] of [
      ["one", "otid-one"],
      ["two", "otid-two"],
    ] as const) {
      expect(
        enqueueInboundUserMessage(runtime, {
          type: "message",
          agentId: "agent-1",
          conversationId: "conv-1",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text }],
              otid,
              client_message_id: otid,
            },
          ],
        }),
      ).toBe(true);
    }

    const batch = consumeQueuedTurn(runtime);
    expect(batch?.dequeuedBatch.items).toHaveLength(2);
    expect(consumeQueuedTurn(runtime)).toBeNull();
  });
});
