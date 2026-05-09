import { afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDiscordInboundAttachments } from "../../channels/discord/media";

const originalFetch = globalThis.fetch;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const attachmentsDir = join(tmpdir(), "letta-discord-attachments");

function restoreOpenAiApiKey(): void {
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreOpenAiApiKey();
  rmSync(attachmentsDir, { recursive: true, force: true });
});

describe("resolveDiscordInboundAttachments", () => {
  test("transcribes audio attachments when opt-in is enabled", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();

      if (href === "https://cdn.discordapp.com/voice-message.ogg") {
        return new Response(Buffer.from("voice-bytes"), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      }

      if (href === "https://api.openai.com/v1/audio/transcriptions") {
        return new Response(JSON.stringify({ text: "Discord voice text" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch URL: ${href}`);
    }) as unknown as typeof fetch;

    const attachments = await resolveDiscordInboundAttachments({
      accountId: "discord-bot",
      chatId: "channel-1",
      transcribeVoice: true,
      rawAttachments: [
        {
          id: "voice-1",
          name: "voice-message.ogg",
          contentType: "audio/ogg",
          size: 11,
          url: "https://cdn.discordapp.com/voice-message.ogg",
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: "audio",
      mimeType: "audio/ogg",
      transcription: "Discord voice text",
    });
  });

  test("skips audio transcription unless opt-in is enabled", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();

      if (href === "https://cdn.discordapp.com/voice-message.ogg") {
        return new Response(Buffer.from("voice-bytes"), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      }

      if (href === "https://api.openai.com/v1/audio/transcriptions") {
        throw new Error(
          "Whisper should not be called when transcription is disabled",
        );
      }

      throw new Error(`Unexpected fetch URL: ${href}`);
    }) as unknown as typeof fetch;

    const attachments = await resolveDiscordInboundAttachments({
      accountId: "discord-bot",
      chatId: "channel-1",
      rawAttachments: [
        {
          id: "voice-1",
          name: "voice-message.ogg",
          contentType: "audio/ogg",
          size: 11,
          url: "https://cdn.discordapp.com/voice-message.ogg",
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).not.toHaveProperty("transcription");
  });
});
