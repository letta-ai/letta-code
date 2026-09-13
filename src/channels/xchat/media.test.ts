import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { collectXChatAttachments, inferXChatUploadMimeType } from "./media";

afterEach(() => {
  __testOverrideChannelsRoot(null);
});

test("downloads bounded inbound attachments for agent inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "letta-xchat-media-"));
  __testOverrideChannelsRoot(root);
  let fetched = false;
  try {
    const attachments = await collectXChatAttachments({
      accountId: "account-1",
      chatId: "sender:bot",
      messageId: "message-1",
      downloadMedia: true,
      mediaMaxBytes: 1024,
      transcribeVoice: false,
      attachments: [
        {
          type: "image",
          name: "avatar.png",
          mimeType: "image/png",
          size: 4,
          fetchData: async () => {
            fetched = true;
            return Buffer.from("test");
          },
        },
      ],
    });

    expect(fetched).toBe(true);
    expect(attachments[0]).toMatchObject({
      id: "message-1:0",
      name: "avatar.png",
      mimeType: "image/png",
      sizeBytes: 4,
      kind: "image",
      sourceMessageId: "message-1",
    });
    expect(attachments[0]?.localPath).toContain("avatar.png");
    expect(readFileSync(attachments[0]?.localPath ?? "")).toEqual(
      Buffer.from("test"),
    );
    if (process.platform !== "win32") {
      expect(statSync(attachments[0]?.localPath ?? "").mode & 0o777).toBe(
        0o600,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not fetch attachments above the configured limit", async () => {
  let fetched = false;
  const attachments = await collectXChatAttachments({
    accountId: "account-1",
    chatId: "sender:bot",
    messageId: "message-1",
    downloadMedia: true,
    mediaMaxBytes: 3,
    transcribeVoice: false,
    attachments: [
      {
        type: "image",
        name: "avatar.png",
        size: 4,
        fetchData: async () => {
          fetched = true;
          return Buffer.from("test");
        },
      },
    ],
  });

  expect(fetched).toBe(false);
  expect(attachments[0]).toMatchObject({
    downloadReason: "exceeds_auto_download_limit",
    autoDownloadLimitBytes: 3,
  });
});

test("detects and transcribes X Chat voice messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "letta-xchat-voice-"));
  __testOverrideChannelsRoot(root);
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    Response.json({ text: "Voice received." })) as unknown as typeof fetch;
  try {
    const bytes = Buffer.from("OggSvoice");
    const attachments = await collectXChatAttachments({
      accountId: "account-1",
      chatId: "sender:bot",
      messageId: "voice-1",
      downloadMedia: true,
      mediaMaxBytes: 1024,
      transcribeVoice: true,
      attachments: [
        {
          type: "audio",
          size: bytes.byteLength,
          fetchData: async () => bytes,
        },
      ],
    });

    expect(attachments[0]).toMatchObject({
      kind: "audio",
      mimeType: "audio/ogg",
      name: "attachment-1.ogg",
      transcription: "Voice received.",
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("infers MIME types for common outbound media", () => {
  expect(inferXChatUploadMimeType("photo.png")).toBe("image/png");
  expect(inferXChatUploadMimeType("document.pdf")).toBe("application/pdf");
  expect(inferXChatUploadMimeType("archive.bin")).toBeUndefined();
});
