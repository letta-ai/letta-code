import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import sharp from "sharp";
import type { Backend } from "@/backend";
import { translatePasteForImages } from "@/cli/helpers/clipboard";
import {
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
} from "@/cli/helpers/paste-registry";
import { MAX_IMAGE_HEIGHT, MAX_IMAGE_WIDTH } from "@/utils/image-resize";
import {
  assertSupportedBase64ImageMediaTypes,
  normalizeMessageImageParts,
} from "@/utils/message-image-normalization";
import { sendMessageStreamWithBackend } from "./message";

const TEST_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=";
const ALLOWED_ANTHROPIC_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function getFirstImageMediaType(message: MessageCreate): string | null {
  if (typeof message.content === "string") {
    return null;
  }

  const imagePart = message.content.find(
    (
      part,
    ): part is {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    } =>
      part.type === "image" &&
      part.source.type === "base64" &&
      typeof part.source.media_type === "string",
  );

  return imagePart?.source.media_type ?? null;
}

async function sendThroughRecordingBackend(
  messages: MessageCreate[],
  options: {
    imageFailureModesByMessageOtid?: Record<string, "strict" | "drop">;
  } = {},
): Promise<ConversationMessageCreateParams> {
  let recordedBody: ConversationMessageCreateParams | undefined;
  const stream = {
    async *[Symbol.asyncIterator]() {},
  } as unknown as Stream<LettaStreamingResponse>;
  const backend = {
    createConversationMessageStream: async (
      _conversationId: string,
      body: ConversationMessageCreateParams,
    ) => {
      recordedBody = body;
      return stream;
    },
  } as unknown as Backend;

  await sendMessageStreamWithBackend(
    backend,
    "conv-image-normalization",
    messages,
    {
      streamTokens: true,
      background: true,
      preparedToolContext: {
        contextId: "ctx-image-normalization",
        clientTools: [],
        loadedToolNames: [],
      },
      ...options,
    },
  );

  if (!recordedBody) {
    throw new Error("Expected the backend request body to be recorded");
  }
  return recordedBody;
}

describe("outbound image normalization", () => {
  let tempRoot = "";
  let displayText = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "letta-image-send-"));
    displayText = "";
  });

  afterEach(() => {
    if (displayText) {
      clearPlaceholdersInText(displayText);
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("normalizes TUI file-path pasted images to Anthropic-supported media types before sending", async () => {
    const imagePath = join(tempRoot, "clipboard-screenshot.tiff");
    writeFileSync(imagePath, Buffer.from(TEST_PNG_BASE64, "base64"));

    displayText = translatePasteForImages(imagePath);
    expect(displayText).toMatch(/^\[Image #\d+\]$/);

    const rawMessages: MessageCreate[] = [
      {
        role: "user",
        content: buildMessageContentFromDisplay(displayText),
      },
    ];
    const rawMessage = rawMessages[0];
    if (!rawMessage) {
      throw new Error("Expected raw TUI message");
    }

    expect(getFirstImageMediaType(rawMessage)).toBe("image/tiff");
    expect(() => assertSupportedBase64ImageMediaTypes(rawMessages)).toThrow(
      /Unsupported base64 image media type/,
    );

    const normalizedMessages = await normalizeMessageImageParts(rawMessages);
    const normalizedMessage = normalizedMessages[0];
    if (!normalizedMessage) {
      throw new Error("Expected normalized TUI message");
    }

    expect(() =>
      assertSupportedBase64ImageMediaTypes(normalizedMessages),
    ).not.toThrow();
    expect(
      ALLOWED_ANTHROPIC_MEDIA_TYPES.has(
        getFirstImageMediaType(normalizedMessage) ?? "",
      ),
    ).toBe(true);
  });

  test("normalizes direct shared-send image payloads before the API request", async () => {
    const rawMessages: MessageCreate[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/heic",
              data: TEST_PNG_BASE64,
            },
          },
        ],
      },
    ];

    expect(() => assertSupportedBase64ImageMediaTypes(rawMessages)).toThrow(
      /Unsupported base64 image media type/,
    );

    const normalizedMessages = await normalizeMessageImageParts(rawMessages);
    const normalizedMessage = normalizedMessages[0];
    if (!normalizedMessage) {
      throw new Error("Expected normalized direct-send message");
    }

    expect(() =>
      assertSupportedBase64ImageMediaTypes(normalizedMessages),
    ).not.toThrow();
    expect(getFirstImageMediaType(normalizedMessage)).toBe("image/png");
  });

  test("fails closed before the API request when base64 image bytes are invalid", async () => {
    const rawMessages: MessageCreate[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/tiff",
              data: Buffer.from("not-an-image", "utf8").toString("base64"),
            },
          },
        ],
      },
    ];

    await expect(normalizeMessageImageParts(rawMessages)).rejects.toThrow();
  });

  test("wraps explicit image normalization failures in a clean error", async () => {
    const rawMessages: MessageCreate[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/heic",
              data: TEST_PNG_BASE64,
            },
          },
        ],
      },
    ];

    await expect(
      normalizeMessageImageParts(rawMessages, {
        resize: async () => {
          throw new Error("codec unavailable");
        },
      }),
    ).rejects.toThrow(/Failed to prepare image for model: codec unavailable/);
  });

  test("normalizes oversized images in the serialized backend request", async () => {
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
    const requestBody = await sendThroughRecordingBackend(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "please inspect this screenshot" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: oversized.toString("base64"),
              },
            },
          ],
          otid: "cm-oversized",
        },
      ],
      // Guard the invariant at runtime: even a stale caller that passes the
      // deleted option cannot bypass the authoritative send-boundary pass.
      { skipImageNormalization: true } as never,
    );
    if (!requestBody.messages) {
      throw new Error("Expected backend request messages");
    }
    const message = requestBody.messages[0];
    if (
      !message ||
      !("content" in message) ||
      typeof message.content === "string"
    ) {
      throw new Error("Expected a multimodal backend request message");
    }
    const imagePart = message.content.find((part) => part.type === "image");
    if (
      !imagePart ||
      imagePart.type !== "image" ||
      imagePart.source.type !== "base64"
    ) {
      throw new Error("Expected a normalized base64 image");
    }

    const metadata = await sharp(
      Buffer.from(imagePart.source.data, "base64"),
    ).metadata();
    expect(metadata.width).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
    expect(metadata.height).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
  });

  test("applies drop policy by message otid at the send boundary", async () => {
    const requestBody = await sendThroughRecordingBackend(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "channel attachment" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/heic",
                data: Buffer.from("not-an-image").toString("base64"),
              },
            },
          ],
          otid: "cm-channel-image",
        },
      ],
      {
        imageFailureModesByMessageOtid: {
          "cm-channel-image": "drop",
        },
      },
    );

    if (!requestBody.messages) {
      throw new Error("Expected backend request messages");
    }
    expect(requestBody.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "channel attachment" }],
      otid: "cm-channel-image",
    });
  });
});
