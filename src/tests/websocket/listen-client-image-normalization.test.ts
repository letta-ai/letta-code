import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "../../websocket/listen-client";

describe("listen-client inbound image normalization", () => {
  test("normalizes base64 image content through the shared resize path", async () => {
    const resize = async (_buffer: Buffer, mediaType: string) => ({
      data: "resized-base64-image",
      mediaType: mediaType === "image/png" ? "image/jpeg" : mediaType,
      width: 1600,
      height: 1200,
      resized: true,
    });

    const normalized = await __listenClientTestUtils.normalizeInboundMessages(
      [
        {
          type: "message",
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "raw-base64-image",
              },
            },
          ],
          client_message_id: "cm-image-1",
        },
      ],
      resize,
    );

    expect(normalized).toHaveLength(1);
    const message = normalized[0];
    if (!message) {
      throw new Error("Expected normalized message");
    }
    expect("content" in message).toBe(true);
    if (!("content" in message) || typeof message.content === "string") {
      throw new Error("Expected multimodal content");
    }
    expect(message.content).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "resized-base64-image",
        },
      },
    ]);
  });
});
