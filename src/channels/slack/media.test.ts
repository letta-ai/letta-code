import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";

const originalFetch = globalThis.fetch;
const originalOpenAIKey = process.env.OPENAI_API_KEY;
let channelsRoot: string | null = null;

function requestUrl(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  const maybeRequest = input as { url?: unknown };
  if (typeof maybeRequest.url === "string") {
    return maybeRequest.url;
  }
  return String(input);
}

beforeEach(async () => {
  channelsRoot = await mkdtemp(join(tmpdir(), "letta-slack-media-"));
  __testOverrideChannelsRoot(channelsRoot);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
  __testOverrideChannelsRoot(null);
  if (channelsRoot) {
    await rm(channelsRoot, { recursive: true, force: true });
    channelsRoot = null;
  }
});

async function loadSlackMediaModule() {
  return import(`./media.ts?slack-media-test=${Date.now()}-${Math.random()}`);
}

test("resolveSlackThreadStarter falls back to forwarded Slack attachment text", async () => {
  const { resolveSlackThreadStarter } = await loadSlackMediaModule();
  const client = {
    conversations: {
      history: mock(async () => ({ messages: [] })),
      replies: mock(async () => ({
        messages: [
          {
            ts: "1712790000.000050",
            user: "U111",
            text: "",
            attachments: [
              {
                author_name: "Forwarded from Product",
                text: "Can someone fix the Slack forwarding context?",
                fallback: "Can someone fix the Slack forwarding context?",
              },
            ],
          },
        ],
      })),
    },
  };

  await expect(
    resolveSlackThreadStarter({
      channelId: "C123",
      threadTs: "1712790000.000050",
      client,
    }),
  ).resolves.toEqual({
    text: "Forwarded from Product\nCan someone fix the Slack forwarding context?",
    userId: "U111",
    botId: undefined,
    ts: "1712790000.000050",
  });
});

test("resolveSlackThreadStarter downloads Slack files for thread context", async () => {
  const fetchMock = mock(async (input: unknown, init?: RequestInit) => {
    expect(requestUrl(input)).toBe(
      "https://files.slack.com/files-pri/T123-FROOT/root.png",
    );
    expect(init).toMatchObject({
      headers: { Authorization: "Bearer xoxb-test-token" },
      redirect: "manual",
    });
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const { resolveSlackThreadStarter } = await loadSlackMediaModule();
  const client = {
    conversations: {
      history: mock(async () => ({ messages: [] })),
      replies: mock(async () => ({
        messages: [
          {
            ts: "1712790000.000050",
            user: "U111",
            text: "Root screenshot",
            files: [
              {
                id: "FROOT",
                name: "root.png",
                mimetype: "image/png",
                url_private_download:
                  "https://files.slack.com/files-pri/T123-FROOT/root.png",
              },
            ],
          },
        ],
      })),
    },
  };

  const starter = await resolveSlackThreadStarter({
    channelId: "C123",
    threadTs: "1712790000.000050",
    client,
    accountId: "slack-bot",
    token: "xoxb-test-token",
    transcribeVoice: false,
  });

  expect(starter).toMatchObject({
    text: "Root screenshot",
    userId: "U111",
    botId: undefined,
    ts: "1712790000.000050",
  });
  expect(starter?.attachments).toHaveLength(1);
  const attachment = starter?.attachments?.[0];
  if (!attachment) {
    throw new Error("Expected starter attachment");
  }
  expect(attachment).toMatchObject({
    id: "FROOT",
    name: "root.png",
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 4,
    localPath: expect.stringContaining("root.png"),
  });
  // Images are not inlined as base64; the agent Reads local_path on demand
  // (LET-9517 — inlined attachments accumulated past provider byte limits).
  expect(attachment.imageDataBase64).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("resolveSlackChannelHistory retains forwarded Slack attachment text", async () => {
  const { resolveSlackChannelHistory } = await loadSlackMediaModule();
  const client = {
    conversations: {
      history: mock(async () => ({
        messages: [
          {
            ts: "1712790000.000090",
            user: "U222",
            text: "",
            attachments: [
              {
                title: "Forwarded message",
                text: "Here is the context from the original channel.",
              },
            ],
          },
        ],
      })),
      replies: mock(async () => ({ messages: [] })),
    },
  };

  await expect(
    resolveSlackChannelHistory({
      channelId: "C123",
      beforeTs: "1712800000.000100",
      client,
    }),
  ).resolves.toEqual([
    {
      text: "Forwarded message\nHere is the context from the original channel.",
      userId: "U222",
      botId: undefined,
      ts: "1712790000.000090",
    },
  ]);
});

test("resolveSlackThreadHistory retains bot-authored Slack replies", async () => {
  const { resolveSlackThreadHistory } = await loadSlackMediaModule();
  const client = {
    conversations: {
      history: mock(async () => ({ messages: [] })),
      replies: mock(async () => ({
        messages: [
          {
            ts: "1712790000.000050",
            user: "U111",
            text: "Thread root",
          },
          {
            ts: "1712795000.000060",
            bot_id: "BDEPLOY",
            text: "Deployment succeeded",
            subtype: "bot_message",
          },
          {
            ts: "1712800000.000100",
            user: "U222",
            text: "Current mention",
          },
        ],
      })),
    },
  };

  await expect(
    resolveSlackThreadHistory({
      channelId: "C123",
      threadTs: "1712790000.000050",
      currentMessageTs: "1712800000.000100",
      client,
    }),
  ).resolves.toEqual([
    {
      text: "Deployment succeeded",
      userId: undefined,
      botId: "BDEPLOY",
      ts: "1712795000.000060",
    },
  ]);
});

test("resolveSlackCurrentMessageAttachments hydrates files from the exact thread message", async () => {
  const fetchMock = mock(async (input: unknown, init?: RequestInit) => {
    expect(requestUrl(input)).toBe(
      "https://files.slack.com/files-pri/T123-FZIP/source.zip",
    );
    expect(init).toMatchObject({
      headers: { Authorization: "Bearer xoxb-test-token" },
      redirect: "manual",
    });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/zip" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const { resolveSlackCurrentMessageAttachments } =
    await loadSlackMediaModule();
  const client = {
    conversations: {
      history: mock(async () => ({ messages: [] })),
      replies: mock(async () => ({
        messages: [
          {
            ts: "1712790000.000050",
            user: "U111",
            text: "Thread root",
          },
          {
            ts: "1712800000.000100",
            user: "U222",
            text: "Here are the files",
            subtype: "thread_broadcast",
            files: [
              {
                id: "FZIP",
                name: "source.zip",
                mimetype: "application/zip",
                url_private_download:
                  "https://files.slack.com/files-pri/T123-FZIP/source.zip",
              },
            ],
          },
        ],
      })),
    },
  };

  const attachments = await resolveSlackCurrentMessageAttachments({
    channelId: "C123",
    threadTs: "1712790000.000050",
    messageTs: "1712800000.000100",
    client,
    accountId: "slack-bot",
    token: "xoxb-test-token",
  });

  expect(attachments).toEqual([
    expect.objectContaining({
      id: "FZIP",
      name: "source.zip",
      mimeType: "application/zip",
      kind: "file",
      sizeBytes: 3,
      localPath: expect.stringContaining("source.zip"),
    }),
  ]);
  expect(client.conversations.replies).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "C123",
      ts: "1712790000.000050",
      inclusive: true,
    }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("resolveSlackThreadHistory bot-only mode skips human attachment downloads", async () => {
  const fetchMock = mock(async () => {
    throw new Error("human history attachment should not be downloaded");
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const { resolveSlackThreadHistory } = await loadSlackMediaModule();
  const client = {
    conversations: {
      history: mock(async () => ({ messages: [] })),
      replies: mock(async () => ({
        messages: [
          {
            ts: "1712790000.000050",
            user: "U111",
            text: "Thread root",
          },
          {
            ts: "1712795000.000060",
            user: "U222",
            text: "Human file context already delivered",
            files: [
              {
                id: "FHUMAN",
                name: "human.png",
                mimetype: "image/png",
                url_private_download:
                  "https://files.slack.com/files-pri/T123-FHUMAN/human.png",
              },
            ],
          },
          {
            ts: "1712796000.000070",
            bot_id: "BDEPLOY",
            text: "Bot status update",
          },
          {
            ts: "1712800000.000100",
            user: "U333",
            text: "Current turn",
          },
        ],
      })),
    },
  };

  await expect(
    resolveSlackThreadHistory({
      channelId: "C123",
      threadTs: "1712790000.000050",
      currentMessageTs: "1712800000.000100",
      client,
      include: "bot",
      accountId: "slack-bot",
      token: "xoxb-test-token",
    }),
  ).resolves.toEqual([
    {
      text: "Bot status update",
      userId: undefined,
      botId: "BDEPLOY",
      ts: "1712796000.000070",
    },
  ]);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("resolveSlackChannelHistory retains bot-authored Slack messages", async () => {
  const { resolveSlackChannelHistory } = await loadSlackMediaModule();
  const client = {
    conversations: {
      history: mock(async () => ({
        messages: [
          {
            ts: "1712799500.000045",
            bot_id: "BSTATUS",
            text: "Automated channel status update",
            subtype: "bot_message",
          },
        ],
      })),
      replies: mock(async () => ({ messages: [] })),
    },
  };

  await expect(
    resolveSlackChannelHistory({
      channelId: "C123",
      beforeTs: "1712800000.000100",
      client,
    }),
  ).resolves.toEqual([
    {
      text: "Automated channel status update",
      userId: undefined,
      botId: "BSTATUS",
      ts: "1712799500.000045",
    },
  ]);
});

test("resolveSlackInboundAttachments transcribes inbound audio when opted in", async () => {
  process.env.OPENAI_API_KEY = "test-openai-key";
  const fetchMock = mock(async (input: unknown) => {
    const url = requestUrl(input);
    if (url === "https://files.slack.com/files-pri/T123-F123/voice.m4a") {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      return new Response(JSON.stringify({ text: "hello slack voice" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const { resolveSlackInboundAttachments } = await loadSlackMediaModule();
  const attachments = await resolveSlackInboundAttachments({
    accountId: "slack-bot",
    token: "xoxb-test-token",
    transcribeVoice: true,
    rawEvent: {
      files: [
        {
          id: "F123",
          name: "voice.m4a",
          size: 3,
          url_private_download:
            "https://files.slack.com/files-pri/T123-F123/voice.m4a",
        },
      ],
    },
  });

  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({
    id: "F123",
    kind: "audio",
    mimeType: "audio/mp4",
    transcription: "hello slack voice",
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("resolveSlackInboundAttachments does not transcribe audio when disabled", async () => {
  process.env.OPENAI_API_KEY = "test-openai-key";
  const fetchMock = mock(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const { resolveSlackInboundAttachments } = await loadSlackMediaModule();
  const attachments = await resolveSlackInboundAttachments({
    accountId: "slack-bot",
    token: "xoxb-test-token",
    transcribeVoice: false,
    rawEvent: {
      files: [
        {
          id: "F123",
          name: "voice.ogg",
          mimetype: "audio/ogg",
          size: 3,
          url_private_download:
            "https://files.slack.com/files-pri/T123-F123/voice.ogg",
        },
      ],
    },
  });

  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({
    id: "F123",
    kind: "audio",
    mimeType: "audio/ogg",
  });
  expect(attachments[0]?.transcription).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("resolveSlackInboundAttachments records transcription errors when OpenAI is not configured", async () => {
  delete process.env.OPENAI_API_KEY;
  const fetchMock = mock(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/ogg" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const { resolveSlackInboundAttachments } = await loadSlackMediaModule();
  const attachments = await resolveSlackInboundAttachments({
    accountId: "slack-bot",
    token: "xoxb-test-token",
    transcribeVoice: true,
    rawEvent: {
      files: [
        {
          id: "F123",
          name: "voice.ogg",
          mimetype: "audio/ogg",
          size: 3,
          url_private_download:
            "https://files.slack.com/files-pri/T123-F123/voice.ogg",
        },
      ],
    },
  });

  expect(attachments).toHaveLength(1);
  expect(attachments[0]).toMatchObject({
    id: "F123",
    kind: "audio",
    transcriptionError: "OPENAI_API_KEY not set; transcription skipped.",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
