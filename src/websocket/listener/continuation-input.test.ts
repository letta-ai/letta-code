import { describe, expect, test } from "bun:test";
import { appendQueuedTurnToInput } from "./continuation-input";

describe("queued continuation input", () => {
  test("appends queued channel images with their best-effort failure policy", () => {
    const queuedOtid = "cm-queued-channel-image";
    const result = appendQueuedTurnToInput(
      {
        messages: [
          {
            type: "approval",
            approvals: [],
            otid: "approval-1",
          },
        ],
      },
      {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        channelTurnSources: [
          {
            channel: "slack",
            chatId: "C123",
            messageId: "1712345.0001",
            agentId: "agent-1",
            conversationId: "conv-1",
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "queued screenshot" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "oversized-image-data",
                },
              },
            ],
            otid: queuedOtid,
          },
        ],
      },
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({
      role: "user",
      otid: queuedOtid,
    });
    expect(result.imageFailureModesByMessageOtid).toEqual({
      [queuedOtid]: "drop",
    });
  });

  test("keeps interactive queued input strict by default", () => {
    const result = appendQueuedTurnToInput(
      { messages: [] },
      {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [
          {
            role: "user",
            content: "queued follow-up",
            otid: "cm-interactive",
          },
        ],
      },
    );

    expect(result.imageFailureModesByMessageOtid).toBeUndefined();
  });
});
