import { afterEach, describe, expect, mock, test } from "bun:test";

import { resolveDiscordInboundAttachments } from "@/channels/discord/media";

describe("Discord media handling", () => {
  const originalFetch = globalThis.fetch;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
  });

  test("transcribes inbound audio attachments when opted in and configured", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const fetchMock = mock(async (input: unknown) => {
      const url = String(input);
      if (url === "https://cdn.discord.test/voice.ogg") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        });
      }
      if (url === "https://api.openai.com/v1/audio/transcriptions") {
        return new Response(JSON.stringify({ text: "hello from audio" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const attachments = await resolveDiscordInboundAttachments({
      accountId: "discord-bot",
      chatId: "channel-1",
      transcribeVoice: true,
      rawAttachments: [
        {
          id: "audio-1",
          name: "voice.ogg",
          contentType: "audio/ogg",
          size: 3,
          url: "https://cdn.discord.test/voice.ogg",
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: "audio-1",
      kind: "audio",
      transcription: "hello from audio",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not call transcription service when audio transcription is disabled", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    const fetchMock = mock(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const attachments = await resolveDiscordInboundAttachments({
      accountId: "discord-bot",
      chatId: "channel-1",
      transcribeVoice: false,
      rawAttachments: [
        {
          id: "audio-1",
          name: "voice.ogg",
          contentType: "audio/ogg",
          size: 3,
          url: "https://cdn.discord.test/voice.ogg",
        },
      ],
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.transcription).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
