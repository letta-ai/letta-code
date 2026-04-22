import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import {
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_WIDTH,
} from "../../cli/helpers/imageResize";
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

  test("clamps oversized base64 image parts to Anthropic many-image limits", async () => {
    const oversized = await sharp({
      create: {
        width: 3200,
        height: 1800,
        channels: 3,
        background: { r: 220, g: 110, b: 30 },
      },
    })
      .png()
      .toBuffer();

    const normalized = await __listenClientTestUtils.normalizeInboundMessages([
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "please inspect these pasted screenshots" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: oversized.toString("base64"),
            },
          },
        ],
        client_message_id: "cm-image-oversized",
      },
    ]);

    const message = normalized[0];
    if (
      !message ||
      !("content" in message) ||
      typeof message.content === "string"
    ) {
      throw new Error("Expected normalized multimodal message");
    }

    const imagePart = message.content[1];
    if (
      !imagePart ||
      imagePart.type !== "image" ||
      imagePart.source.type !== "base64"
    ) {
      throw new Error("Expected normalized base64 image content");
    }

    const resizedBuffer = Buffer.from(imagePart.source.data, "base64");
    const metadata = await sharp(resizedBuffer).metadata();

    expect(metadata.width).toBeDefined();
    expect(metadata.height).toBeDefined();
    expect(metadata.width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
    expect(metadata.height).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
  });
});
