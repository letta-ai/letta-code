import { describe, expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";

describe("listener queue image policy", () => {
  test("does not coalesce channel and interactive messages", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    const interactiveOtid = "cm-interactive-image";
    const channelOtid = "cm-channel-text";

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
        channelTurnSources: [
          {
            channel: "slack",
            chatId: "C123",
            messageId: "1712345.0003",
            agentId: "agent-1",
            conversationId: "conv-1",
          },
        ],
        messages: [
          {
            role: "user",
            content: "channel follow-up",
            otid: channelOtid,
            client_message_id: channelOtid,
          },
        ],
      }),
    ).toBe(true);

    const interactiveBatch = consumeQueuedTurn(runtime);
    expect(interactiveBatch?.dequeuedBatch.items).toHaveLength(1);
    expect(interactiveBatch?.queuedTurn.channelTurnSources).toBeUndefined();
    expect(interactiveBatch?.queuedTurn.messages[0]).toMatchObject({
      otid: interactiveOtid,
    });

    const channelBatch = consumeQueuedTurn(runtime);
    expect(channelBatch?.dequeuedBatch.items).toHaveLength(1);
    expect(channelBatch?.queuedTurn.channelTurnSources).toHaveLength(1);
    expect(channelBatch?.queuedTurn.messages[0]).toMatchObject({
      otid: channelOtid,
    });
  });
});
