import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  buildWhatsAppOutboundPayload,
  collectWhatsAppAttachments,
  extractMentionedJids,
  extractReplyParticipant,
  extractWhatsAppText,
} from "@/channels/whatsapp/media";

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
    // By default (audioAsVoiceMemo not set), .ogg falls through to document.
    expect(
      buildWhatsAppOutboundPayload({
        text: "",
        mediaPath: "/tmp/voice.ogg",
      }),
    ).toEqual({
      document: { url: "/tmp/voice.ogg" },
      fileName: "voice.ogg",
      mimetype: "application/octet-stream",
    });
  });

  test("sends .ogg as voice memo when audioAsVoiceMemo is true", () => {
    expect(
      buildWhatsAppOutboundPayload(
        {
          text: "",
          mediaPath: "/tmp/voice.ogg",
        },
        { audioAsVoiceMemo: true },
      ),
    ).toEqual({
      audio: { url: "/tmp/voice.ogg" },
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });
  });

  test("sends .mp3 as document by default", () => {
    expect(
      buildWhatsAppOutboundPayload({
        text: "",
        mediaPath: "/tmp/audio.mp3",
      }),
    ).toEqual({
      document: { url: "/tmp/audio.mp3" },
      fileName: "audio.mp3",
      mimetype: "application/octet-stream",
    });
  });

  test("rejects non-Ogg/Opus audio when audioAsVoiceMemo is true", () => {
    expect(() =>
      buildWhatsAppOutboundPayload(
        {
          text: "",
          mediaPath: "/tmp/voice.mp3",
        },
        { audioAsVoiceMemo: true },
      ),
    ).toThrow(/Ogg\/Opus/);
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

  test("stops downloading when streamed media exceeds the byte cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "whatsapp-media-"));
    __testOverrideChannelsRoot(root);
    try {
      async function* oversizedStream() {
        yield Buffer.from("12");
        yield Buffer.from("34");
      }

      const result = await collectWhatsAppAttachments({
        accountId: "acct",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg2",
        message: {
          imageMessage: {
            mimetype: "image/jpeg",
          },
        },
        downloadContentFromMessage: async () => oversizedStream(),
        downloadMedia: true,
        mediaMaxBytes: 3,
        transcribeVoice: false,
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toEqual(
        expect.objectContaining({
          kind: "image",
          mimeType: "image/jpeg",
          localPath: "",
        }),
      );
    } finally {
      __testOverrideChannelsRoot(null);
      await rm(root, { recursive: true, force: true });
    }
  });
});
