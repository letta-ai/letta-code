import { expect, mock, test } from "bun:test";

async function loadSlackMediaModule() {
  return import(
    `./slack/media.ts?slack-media-test=${Date.now()}-${Math.random()}`
  );
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
