import { expect, test } from "bun:test";
import {
  createSlackAdapter,
  FakeSlackApp,
  installSlackAdapterTestHooks,
  resolveSlackChannelHistoryMock,
  resolveSlackCurrentMessageAttachmentsMock,
  resolveSlackThreadHistoryMock,
  resolveSlackThreadStarterMock,
  slackAccountDefaults,
} from "./adapter-test-harness";

installSlackAdapterTestHooks();

test("slack adapter hydrates prior Slack thread context, including bot-authored entries, on the first routed turn", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  if (!app) {
    throw new Error("Expected Slack app instance");
  }

  resolveSlackThreadStarterMock.mockResolvedValueOnce({
    text: "Original question from the thread root",
    userId: "U111",
    ts: "1712790000.000050",
    attachments: [
      {
        id: "FROOT",
        name: "root-screenshot.png",
        mimeType: "image/png",
        kind: "image",
        localPath: "/tmp/root-screenshot.png",
      },
    ],
  });
  resolveSlackThreadHistoryMock.mockResolvedValueOnce([
    {
      text: "Some follow-up before the bot was tagged",
      userId: "U222",
      ts: "1712795000.000060",
    },
    {
      text: "Automated deployment note before the bot was tagged",
      botId: "BDEPLOY",
      ts: "1712796000.000070",
    },
  ]);

  const prepared = await adapter.prepareInboundMessage?.(
    {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "C123",
      chatLabel: "#random",
      senderId: "U123",
      senderName: "Charles",
      text: "please help",
      timestamp: 1712800000100,
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: true,
    },
    { isFirstRouteTurn: true },
  );

  expect(prepared).toBeDefined();
  expect(prepared?.threadContext?.starter).toEqual(
    expect.objectContaining({
      messageId: "1712790000.000050",
      senderId: "U111",
      text: "Original question from the thread root",
      attachments: [
        expect.objectContaining({
          id: "FROOT",
          localPath: "/tmp/root-screenshot.png",
        }),
      ],
    }),
  );
  expect(prepared?.threadContext?.history).toEqual([
    expect.objectContaining({
      messageId: "1712795000.000060",
      senderId: "U222",
      text: "Some follow-up before the bot was tagged",
    }),
    expect.objectContaining({
      messageId: "1712796000.000070",
      senderId: "BDEPLOY",
      senderName: "Bot (BDEPLOY)",
      text: "Automated deployment note before the bot was tagged",
    }),
  ]);
  expect(prepared?.threadContext?.label).toContain("Slack thread in #random");
  expect(resolveSlackThreadStarterMock).toHaveBeenCalledTimes(1);
  expect(resolveSlackThreadStarterMock).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "slack-test-account",
      token: "xoxb-test-token-1234567890",
      transcribeVoice: false,
    }),
  );
  expect(resolveSlackThreadHistoryMock).toHaveBeenCalledTimes(1);
  expect(resolveSlackThreadHistoryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "slack-test-account",
      token: "xoxb-test-token-1234567890",
      transcribeVoice: false,
    }),
  );
});

test("slack adapter rehydrates bot-authored Slack thread context on existing routed turns", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  // Bot-only filtering now happens inside resolveSlackThreadHistory via the
  // include: "bot" parameter, so the mock models the already-filtered result.
  resolveSlackThreadHistoryMock.mockResolvedValueOnce([
    {
      text: "Automated deployment note since the last human turn",
      botId: "BDEPLOY",
      ts: "1712796000.000070",
    },
  ]);

  const prepared = await adapter.prepareInboundMessage?.(
    {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "C123",
      chatLabel: "#random",
      senderId: "U123",
      senderName: "Charles",
      text: "what did deploy say?",
      timestamp: 1712800000100,
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
    },
    { isFirstRouteTurn: false },
  );

  expect(prepared).toBeDefined();
  expect(prepared?.threadContext?.starter).toBeUndefined();
  expect(prepared?.threadContext?.history).toEqual([
    expect.objectContaining({
      messageId: "1712796000.000070",
      senderId: "BDEPLOY",
      senderName: "Bot (BDEPLOY)",
      text: "Automated deployment note since the last human turn",
    }),
  ]);
  expect(resolveSlackThreadStarterMock).not.toHaveBeenCalled();
  expect(resolveSlackThreadHistoryMock).toHaveBeenCalledTimes(1);
  expect(resolveSlackThreadHistoryMock).toHaveBeenCalledWith(
    expect.objectContaining({ include: "bot" }),
  );
  expect(resolveSlackChannelHistoryMock).not.toHaveBeenCalled();
});

test("slack adapter hydrates recent channel context, including bot-authored entries, when a mention creates a new thread", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  resolveSlackChannelHistoryMock.mockResolvedValueOnce([
    {
      text: "Earlier channel context before the mention",
      userId: "U111",
      ts: "1712799000.000040",
    },
    {
      text: "Automated channel update before the mention",
      botId: "BSTATUS",
      ts: "1712799250.000042",
    },
    {
      text: "More recent channel context before the mention",
      userId: "U222",
      ts: "1712799500.000045",
    },
  ]);

  const prepared = await adapter.prepareInboundMessage?.(
    {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "C123",
      chatLabel: "#random",
      senderId: "U123",
      senderName: "Charles",
      text: "please help",
      timestamp: 1712800000100,
      messageId: "1712800000.000100",
      threadId: "1712800000.000100",
      chatType: "channel",
      isMention: true,
    },
    { isFirstRouteTurn: true },
  );

  expect(prepared).toBeDefined();
  expect(prepared?.threadContext?.starter).toBeUndefined();
  expect(prepared?.threadContext?.history).toEqual([
    expect.objectContaining({
      messageId: "1712799000.000040",
      senderId: "U111",
      text: "Earlier channel context before the mention",
    }),
    expect.objectContaining({
      messageId: "1712799250.000042",
      senderId: "BSTATUS",
      senderName: "Bot (BSTATUS)",
      text: "Automated channel update before the mention",
    }),
    expect.objectContaining({
      messageId: "1712799500.000045",
      senderId: "U222",
      text: "More recent channel context before the mention",
    }),
  ]);
  expect(prepared?.threadContext?.label).toContain(
    "Slack channel context in #random before thread start",
  );
  expect(resolveSlackChannelHistoryMock).toHaveBeenCalledTimes(1);
  expect(resolveSlackThreadStarterMock).not.toHaveBeenCalled();
  expect(resolveSlackThreadHistoryMock).not.toHaveBeenCalled();
});

test("slack adapter hydrates exact thread_broadcast attachments before prompt formatting", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
  });

  await adapter.start();

  resolveSlackCurrentMessageAttachmentsMock.mockResolvedValueOnce([
    {
      id: "FZIP",
      name: "source.zip",
      mimeType: "application/zip",
      kind: "file",
      localPath: "/tmp/source.zip",
    },
  ]);

  const prepared = await adapter.prepareInboundMessage?.(
    {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "C123",
      chatLabel: "#random",
      senderId: "U123",
      senderName: "Dorota",
      text: "broadcasting files",
      timestamp: 1712800000100,
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
      raw: {
        type: "message",
        subtype: "thread_broadcast",
        channel: "C123",
        user: "U123",
        ts: "1712800000.000100",
        thread_ts: "1712790000.000050",
      },
    },
    { isFirstRouteTurn: false },
  );

  expect(prepared?.attachments).toEqual([
    expect.objectContaining({ id: "FZIP", localPath: "/tmp/source.zip" }),
  ]);
  expect(resolveSlackCurrentMessageAttachmentsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      channelId: "C123",
      threadTs: "1712790000.000050",
      messageTs: "1712800000.000100",
      accountId: "slack-test-account",
      token: "xoxb-test-token-1234567890",
    }),
  );
  expect(resolveSlackThreadHistoryMock).toHaveBeenCalledWith(
    expect.objectContaining({ include: "bot" }),
  );
});
