import { describe, expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";

describe("listener queue image policy", () => {
  test("does not coalesce messages with image content", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    const interactiveOtid = "cm-interactive-image";
    const followUpOtid = "cm-follow-up-text";

    expect(
      enqueueInboundUserMessage(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "interactive screenshot" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "interactive-image-data",
                },
              },
            ],
            otid: interactiveOtid,
            client_message_id: interactiveOtid,
          },
        ],
      }),
    ).toBe(true);
    expect(
      enqueueInboundUserMessage(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        noCoalesce: true,
        messages: [
          {
            role: "user",
            content: "follow-up",
            otid: followUpOtid,
            client_message_id: followUpOtid,
          },
        ],
      }),
    ).toBe(true);

    const firstBatch = consumeQueuedTurn(runtime);
    expect(firstBatch?.dequeuedBatch.items).toHaveLength(1);
    expect(firstBatch?.queuedTurn.messages[0]).toMatchObject({
      otid: interactiveOtid,
    });

    const secondBatch = consumeQueuedTurn(runtime);
    expect(secondBatch?.dequeuedBatch.items).toHaveLength(1);
    expect(secondBatch?.queuedTurn.messages[0]).toMatchObject({
      otid: followUpOtid,
    });
  });
});
