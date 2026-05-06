import { describe, expect, test } from "bun:test";
import {
  buildWhatsAppOutboundPayload,
  collectWhatsAppAttachments,
  extractMentionedJids,
  extractReplyParticipant,
  extractWhatsAppText,
} from "../../channels/whatsapp/media";

describe("WhatsApp media helpers", () => {
  test("extracts text and captions from wrapped message content", () => {
    expect(extractWhatsAppText({ conversation: "hello" })).toBe("hello");
    expect(
      extractWhatsAppText({
        ephemeralMessage: {
          message: { imageMessage: { caption: "photo caption" } },
        },
      }),
    ).toBe("photo caption");
  });

  test("extracts mentions and reply participants from context info", () => {
    const message = {
      extendedTextMessage: {
        text: "loop",
        contextInfo: {
          mentionedJid: ["15551234567@s.whatsapp.net"],
          participant: "15550000000@s.whatsapp.net",
        },
      },
    };
    expect(extractMentionedJids(message)).toEqual([
      "15551234567@s.whatsapp.net",
    ]);
    expect(extractReplyParticipant(message)).toBe("15550000000@s.whatsapp.net");
  });

  test("builds outbound payloads by file type", () => {
    expect(
      buildWhatsAppOutboundPayload({
        text: "caption",
        mediaPath: "/tmp/photo.png",
      }),
    ).toEqual({ image: { url: "/tmp/photo.png" }, caption: "caption" });
    expect(
      buildWhatsAppOutboundPayload({
        text: "",
        mediaPath: "/tmp/voice.ogg",
      }),
    ).toEqual({ audio: { url: "/tmp/voice.ogg" }, ptt: true });
  });

  test("returns attachment metadata without downloading when media is disabled", async () => {
    const result = await collectWhatsAppAttachments({
      accountId: "acct",
      chatId: "15551234567@s.whatsapp.net",
      messageId: "msg1",
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: 123,
        },
      },
      downloadMedia: false,
      transcribeVoice: false,
    });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual(
      expect.objectContaining({
        kind: "image",
        mimeType: "image/jpeg",
        sizeBytes: 123,
        localPath: "",
      }),
    );
  });
});
