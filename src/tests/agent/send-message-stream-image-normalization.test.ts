import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { translatePasteForImages } from "../../cli/helpers/clipboard";
import {
  buildMessageContentFromDisplay,
  clearPlaceholdersInText,
} from "../../cli/helpers/pasteRegistry";
import {
  assertSupportedBase64ImageMediaTypes,
  normalizeMessageImageParts,
} from "../../utils/messageImageNormalization";

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
      normalizeMessageImageParts(rawMessages, async () => {
        throw new Error("codec unavailable");
      }),
    ).rejects.toThrow(/Failed to prepare image for model: codec unavailable/);
  });
});
