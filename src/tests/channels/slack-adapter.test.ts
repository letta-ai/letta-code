import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelMessageAttachment } from "../../channels/types";

type SlackMessageHandler = (args: {
  message: {
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    subtype?: string;
    hidden?: boolean;
    bot_id?: string;
    files?: Array<{ id?: string; name?: string }>;
    message?: Record<string, unknown>;
  };
}) => Promise<void>;

type SlackEventHandler = (args: {
  event: {
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    item?: {
      type?: string;
      channel?: string;
      ts?: string;
    };
    item_user?: string;
    reaction?: string;
    event_ts?: string;
  };
}) => Promise<void>;

class FakeSlackApp {
  static instances: FakeSlackApp[] = [];

  readonly client = {
    auth: {
      test: mock(async () => ({
        team: "Test Workspace",
        user: "letta_code_charles_le",
        user_id: "U0AS42PTEAX",
      })),
    },
    users: {
      info: mock(async () => ({
        user: {
          name: "letta_code_charles_le",
          profile: {
            display_name: "Letta Code (Charles Letta Code app test)",
            real_name: "Letta Code",
          },
        },
      })),
    },
    chat: {
      postMessage: mock(async () => ({ ts: "1712800000.000100" })),
    },
    conversations: {
      history: mock(async () => ({ messages: [] })),
      replies: mock(async () => ({ messages: [] })),
    },
    reactions: {
      add: mock(async () => ({ ok: true })),
      remove: mock(async () => ({ ok: true })),
    },
    files: {
      getUploadURLExternal: mock(async () => ({
        ok: true,
        upload_url: "https://files.slack.com/upload/F123",
        file_id: "F123",
      })),
      completeUploadExternal: mock(async () => ({ ok: true })),
    },
  };

  messageHandler: SlackMessageHandler | null = null;
  eventHandlers = new Map<string, SlackEventHandler>();
  errorHandler: ((error: Error) => Promise<void>) | null = null;
  readonly init = mock(async () => {});
  readonly start = mock(async () => {});
  readonly stop = mock(async () => {});

  constructor(_options: Record<string, unknown>) {
    FakeSlackApp.instances.push(this);
  }

  message(handler: SlackMessageHandler): void {
    this.messageHandler = handler;
  }

  event(name: string, handler: SlackEventHandler): void {
    this.eventHandlers.set(name, handler);
  }

  error(handler: (error: Error) => Promise<void>): void {
    this.errorHandler = handler;
  }
}

class FakeSlackWriteClient {
  static instances: FakeSlackWriteClient[] = [];

  readonly token: string;
  readonly options: Record<string, unknown> | undefined;
  readonly chat = {
    postMessage: mock(async () => ({ ts: "1712800000.000100" })),
  };
  readonly reactions = {
    add: mock(async () => ({ ok: true })),
    remove: mock(async () => ({ ok: true })),
  };
  readonly files = {
    getUploadURLExternal: mock(async () => ({
      ok: true,
      upload_url: "https://files.slack.com/upload/F123",
      file_id: "F123",
    })),
    completeUploadExternal: mock(async () => ({ ok: true })),
  };

  constructor(token: string, options?: Record<string, unknown>) {
    this.token = token;
    this.options = options;
    FakeSlackWriteClient.instances.push(this);
  }
}

const resolveSlackInboundAttachmentsMock = mock(
  async (): Promise<ChannelMessageAttachment[]> => [],
);
const resolveSlackThreadStarterMock = mock(
  async (): Promise<{
    text: string;
    userId?: string;
    botId?: string;
    ts?: string;
  } | null> => null,
);
const resolveSlackThreadHistoryMock = mock(
  async (): Promise<
    Array<{
      text: string;
      userId?: string;
      botId?: string;
      ts?: string;
    }>
  > => [],
);
const resolveSlackChannelHistoryMock = mock(
  async (): Promise<
    Array<{
      text: string;
      userId?: string;
      botId?: string;
      ts?: string;
    }>
  > => [],
);

mock.module("../../channels/slack/runtime", () => ({
  loadSlackBoltModule: async () => ({
    App: FakeSlackApp,
    default: {
      App: FakeSlackApp,
    },
  }),
  loadSlackWebApiModule: async () => ({
    WebClient: FakeSlackWriteClient,
    default: {
      WebClient: FakeSlackWriteClient,
    },
  }),
}));

mock.module("../../channels/slack/media", () => ({
  resolveSlackChannelHistory: resolveSlackChannelHistoryMock,
  resolveSlackInboundAttachments: resolveSlackInboundAttachmentsMock,
  resolveSlackThreadStarter: resolveSlackThreadStarterMock,
  resolveSlackThreadHistory: resolveSlackThreadHistoryMock,
}));

const { createSlackAdapter, resolveSlackAccountDisplayName } = await import(
  "../../channels/slack/adapter"
);

const slackAccountDefaults = {
  accountId: "slack-test-account",
  displayName: "Test Workspace",
  agentId: null,
  defaultPermissionMode: "default",
  createdAt: "2026-04-11T00:00:00.000Z",
  updatedAt: "2026-04-11T00:00:00.000Z",
} as const;

const originalFetch = globalThis.fetch;
const fetchMock = mock(
  async () =>
    new Response("uploaded", {
      status: 200,
    }),
);

beforeEach(() => {
  FakeSlackApp.instances.length = 0;
  FakeSlackWriteClient.instances.length = 0;
  resolveSlackInboundAttachmentsMock.mockReset();
  resolveSlackInboundAttachmentsMock.mockImplementation(async () => []);
  resolveSlackThreadStarterMock.mockReset();
  resolveSlackThreadStarterMock.mockImplementation(async () => null);
  resolveSlackThreadHistoryMock.mockReset();
  resolveSlackThreadHistoryMock.mockImplementation(async () => []);
  resolveSlackChannelHistoryMock.mockReset();
  resolveSlackChannelHistoryMock.mockImplementation(async () => []);
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  for (const instance of FakeSlackApp.instances) {
    instance.client.auth.test.mockClear();
    instance.client.users.info.mockClear();
    instance.client.chat.postMessage.mockClear();
    instance.client.conversations.history.mockClear();
    instance.client.conversations.replies.mockClear();
    instance.client.reactions.add.mockClear();
    instance.client.reactions.remove.mockClear();
    instance.client.files.getUploadURLExternal.mockClear();
    instance.client.files.completeUploadExternal.mockClear();
    instance.init.mockClear();
    instance.start.mockClear();
    instance.stop.mockClear();
  }
  for (const instance of FakeSlackWriteClient.instances) {
    instance.chat.postMessage.mockClear();
    instance.reactions.add.mockClear();
    instance.reactions.remove.mockClear();
    instance.files.getUploadURLExternal.mockClear();
    instance.files.completeUploadExternal.mockClear();
  }
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.restore();
});

test("slack adapter start does not re-run bolt init", async () => {
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
  expect(app).toBeDefined();
  expect(app?.init).not.toHaveBeenCalled();
  expect(app?.start).toHaveBeenCalledTimes(1);
});

test("resolveSlackAccountDisplayName prefers the Slack bot profile display name", async () => {
  await expect(
    resolveSlackAccountDisplayName(
      "xoxb-test-token-1234567890",
      "xapp-test-token-1234567890",
    ),
  ).resolves.toBe("Letta Code (Charles Letta Code app test)");
});

test("slack adapter maps thread metadata to thread_ts", async () => {
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
  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "hello",
    threadId: "1712800000.000200",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient).toBeDefined();
  expect(writeClient?.options).toEqual({
    retryConfig: {
      retries: 0,
    },
  });
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "hello",
    thread_ts: "1712800000.000200",
  });
});

test("slack adapter sendDirectReply uses the dedicated write client", async () => {
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
  await adapter.sendDirectReply("C123", "reply text", {
    replyToMessageId: "1712800000.000200",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "reply text",
    thread_ts: "1712800000.000200",
  });
});

test("slack adapter forwards DM messages as direct channel input", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) {
    throw new Error("Expected Slack message handler");
  }

  await handler({
    message: {
      channel: "D123",
      user: "U123",
      text: "hello from slack",
      ts: "1712800000.000100",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "D123",
      senderId: "U123",
      text: "hello from slack",
      messageId: "1712800000.000100",
      chatType: "direct",
    }),
  );
});

test("slack adapter forwards app mentions as channel input", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.eventHandlers.get("app_mention");
  if (!handler) {
    throw new Error("Expected app_mention handler");
  }

  await handler({
    event: {
      channel: "C123",
      user: "U123",
      text: "<@U999> please help",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "please help",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: true,
    }),
  );
});

test("slack adapter forwards threaded channel replies as channel input", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) {
    throw new Error("Expected Slack message handler");
  }

  await handler({
    message: {
      channel: "C123",
      user: "U123",
      text: "following up in thread",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "following up in thread",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
    }),
  );
});

test("slack adapter hydrates prior Slack thread context on the first routed turn", async () => {
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
  });
  resolveSlackThreadHistoryMock.mockResolvedValueOnce([
    {
      text: "Some follow-up before the bot was tagged",
      userId: "U222",
      ts: "1712795000.000060",
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
    }),
  );
  expect(prepared?.threadContext?.history).toEqual([
    expect.objectContaining({
      messageId: "1712795000.000060",
      senderId: "U222",
      text: "Some follow-up before the bot was tagged",
    }),
  ]);
  expect(prepared?.threadContext?.label).toContain("Slack thread in #random");
  expect(resolveSlackThreadStarterMock).toHaveBeenCalledTimes(1);
  expect(resolveSlackThreadHistoryMock).toHaveBeenCalledTimes(1);
});

test("slack adapter hydrates recent channel context when a mention creates a new thread", async () => {
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

test("slack adapter dedupes threaded mentions delivered through message and app_mention", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const messageHandler = app?.messageHandler;
  const mentionHandler = app?.eventHandlers.get("app_mention");
  if (!messageHandler || !mentionHandler) {
    throw new Error("Expected Slack message and mention handlers");
  }

  await messageHandler({
    message: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> following up in thread",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  await mentionHandler({
    event: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> following up in thread",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "following up in thread",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: true,
    }),
  );
});

test("slack adapter dedupes threaded mentions when app_mention arrives first", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const messageHandler = app?.messageHandler;
  const mentionHandler = app?.eventHandlers.get("app_mention");
  if (!messageHandler || !mentionHandler) {
    throw new Error("Expected Slack message and mention handlers");
  }

  await mentionHandler({
    event: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> still there?",
      ts: "1712800000.000101",
      thread_ts: "1712790000.000050",
    },
  });

  await messageHandler({
    message: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> still there?",
      ts: "1712800000.000101",
      thread_ts: "1712790000.000050",
    },
  });

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "still there?",
      messageId: "1712800000.000101",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: true,
    }),
  );
});

test("slack adapter allows file_share subtype messages through", async () => {
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

  resolveSlackInboundAttachmentsMock.mockResolvedValueOnce([
    {
      id: "F123",
      name: "screenshot.png",
      mimeType: "image/png",
      kind: "image",
      localPath: "/tmp/screenshot.png",
      imageDataBase64: "abc",
    },
  ]);

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) {
    throw new Error("Expected Slack message handler");
  }

  await handler({
    message: {
      channel: "C123",
      user: "U123",
      text: "",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
      subtype: "file_share",
      files: [{ id: "F123", name: "screenshot.png" }],
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: "C123",
      threadId: "1712790000.000050",
      attachments: [
        expect.objectContaining({
          id: "F123",
          name: "screenshot.png",
        }),
      ],
    }),
  );
});

test("slack adapter allows thread_broadcast subtype replies through", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) {
    throw new Error("Expected Slack message handler");
  }

  await handler({
    message: {
      channel: "C123",
      user: "U123",
      text: "broadcasting this reply",
      ts: "1712800000.000101",
      thread_ts: "1712790000.000050",
      subtype: "thread_broadcast",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "broadcasting this reply",
      messageId: "1712800000.000101",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
    }),
  );
});

test("slack adapter ignores hidden bookkeeping thread wrapper events", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) {
    throw new Error("Expected Slack message handler");
  }

  await handler({
    message: {
      channel: "C123",
      ts: "1712800000.000102",
      hidden: true,
      subtype: "message_replied",
      message: {
        type: "message",
        user: "U123",
        text: "Original thread root",
        thread_ts: "1712790000.000050",
        ts: "1712790000.000050",
      },
    },
  });

  expect(onMessage).not.toHaveBeenCalled();
});

test("slack adapter forwards reaction events into the routed Slack thread", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const messageHandler = app?.messageHandler;
  const reactionHandler = app?.eventHandlers.get("reaction_added");
  if (!messageHandler || !reactionHandler) {
    throw new Error("Expected Slack message and reaction handlers");
  }

  await messageHandler({
    message: {
      channel: "C123",
      user: "U123",
      text: "following up in thread",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  onMessage.mockClear();

  await reactionHandler({
    event: {
      user: "U555",
      item_user: "U123",
      reaction: "eyes",
      event_ts: "1712800001.000200",
      item: {
        type: "message",
        channel: "C123",
        ts: "1712800000.000100",
      },
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      text: "Slack reaction added: :eyes:",
      reaction: {
        action: "added",
        emoji: "eyes",
        targetMessageId: "1712800000.000100",
        targetSenderId: "U123",
      },
    }),
  );
});

test("slack adapter can add reactions to messages", async () => {
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
  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "",
    reaction: ":white_check_mark:",
    targetMessageId: "1712800000.000100",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.reactions.add).toHaveBeenCalledWith({
    channel: "C123",
    timestamp: "1712800000.000100",
    name: "white_check_mark",
  });
});

test("slack adapter adds eyes while a queued turn is processing, then swaps to checkmark on completion", async () => {
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

  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "C123",
      chatType: "channel",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.reactions.add).toHaveBeenNthCalledWith(1, {
    channel: "C123",
    timestamp: "1712800000.000100",
    name: "eyes",
  });
  expect(writeClient?.reactions.remove).toHaveBeenCalledWith({
    channel: "C123",
    timestamp: "1712800000.000100",
    name: "eyes",
  });
  expect(writeClient?.reactions.add).toHaveBeenNthCalledWith(2, {
    channel: "C123",
    timestamp: "1712800000.000100",
    name: "white_check_mark",
  });
});

test("slack adapter swaps queued turns to x when the turn fails", async () => {
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

  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "D123",
      chatType: "direct",
      messageId: "1712800000.000200",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
    },
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-2",
    outcome: "error",
    sources: [
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "D123",
        chatType: "direct",
        messageId: "1712800000.000200",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.reactions.remove).toHaveBeenCalledWith({
    channel: "D123",
    timestamp: "1712800000.000200",
    name: "eyes",
  });
  expect(writeClient?.reactions.add).toHaveBeenNthCalledWith(2, {
    channel: "D123",
    timestamp: "1712800000.000200",
    name: "x",
  });
  expect(writeClient?.chat.postMessage).not.toHaveBeenCalled();
});

test("slack adapter posts the lifecycle error back into the same thread as a code block", async () => {
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

  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "C123",
      chatType: "channel",
      messageId: "1712800000.000300",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-3",
    outcome: "error",
    error: "Boom: something went wrong\nsecond line",
    sources: [
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000300",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.reactions.add).toHaveBeenNthCalledWith(2, {
    channel: "C123",
    timestamp: "1712800000.000300",
    name: "x",
  });
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "Turn failed:\n```\nBoom: something went wrong\nsecond line\n```",
    thread_ts: "1712790000.000050",
  });
});

test("slack adapter dedupes lifecycle error posts by reply destination", async () => {
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

  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "C123",
      chatType: "channel",
      messageId: "1712800000.000401",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: {
      channel: "slack",
      accountId: "slack-test-account",
      chatId: "C123",
      chatType: "channel",
      messageId: "1712800000.000402",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
  });

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-4",
    outcome: "error",
    error: "Debounced batch failure",
    sources: [
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000401",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000402",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "Turn failed:\n```\nDebounced batch failure\n```",
    thread_ts: "1712790000.000050",
  });
});

test("slack adapter does not post an extra lifecycle message for cancelled turns", async () => {
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

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-5",
    outcome: "cancelled",
    error: "Should not be posted",
    sources: [
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000500",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).not.toHaveBeenCalled();
});

test("slack adapter uploads local files through Slack's external upload flow", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "letta-slack-upload-"));
  const mediaPath = join(tempDir, "chart.png");
  await writeFile(mediaPath, "fake-image-data");

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
  const result = await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "latest chart",
    mediaPath,
    fileName: "chart.png",
    title: "Chart",
    threadId: "1712790000.000050",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.files.getUploadURLExternal).toHaveBeenCalledWith({
    filename: "chart.png",
    length: "fake-image-data".length,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://files.slack.com/upload/F123",
    {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: expect.any(Uint8Array),
    },
  );
  expect(writeClient?.files.completeUploadExternal).toHaveBeenCalledWith({
    files: [{ id: "F123", title: "Chart" }],
    channel_id: "C123",
    initial_comment: "latest chart",
    thread_ts: "1712790000.000050",
  });
  expect(result).toEqual({ messageId: "F123" });
});

test("slack adapter preserves non-leading user mentions in app mention text", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.eventHandlers.get("app_mention");
  if (!handler) {
    throw new Error("Expected app_mention handler");
  }

  await handler({
    event: {
      channel: "C123",
      user: "U123",
      text: "<@U999> ask <@U555> for help",
      ts: "1712800000.000100",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      text: "ask <@U555> for help",
    }),
  );
});

// ── Inbound debounce integration tests ────────────────────────────

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("inbound debounce: burst of 3 DMs collapse into a single dispatch", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
    inboundDebounceMs: 40,
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) throw new Error("Expected Slack message handler");

  await handler({
    message: {
      channel: "D123",
      user: "U123",
      text: "hey",
      ts: "1712800000.000001",
    },
  });
  await handler({
    message: {
      channel: "D123",
      user: "U123",
      text: "quick question",
      ts: "1712800000.000002",
    },
  });
  await handler({
    message: {
      channel: "D123",
      user: "U123",
      text: "about the plan",
      ts: "1712800000.000003",
    },
  });

  // Still within the window — nothing dispatched yet.
  expect(onMessage).not.toHaveBeenCalled();

  await sleep(80);

  expect(onMessage).toHaveBeenCalledTimes(1);
  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "D123",
      senderId: "U123",
      text: "hey\nquick question\nabout the plan",
      messageId: "1712800000.000003",
      chatType: "direct",
    }),
  );
});

test("inbound debounce: 0ms preserves today's per-event dispatch", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
    inboundDebounceMs: 0,
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) throw new Error("Expected Slack message handler");

  await handler({
    message: {
      channel: "D123",
      user: "U123",
      text: "one",
      ts: "1712800000.000001",
    },
  });
  await handler({
    message: {
      channel: "D123",
      user: "U123",
      text: "two",
      ts: "1712800000.000002",
    },
  });

  expect(onMessage).toHaveBeenCalledTimes(2);
});

test("inbound debounce: attachment mid-burst flushes pending debounced messages first", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
    inboundDebounceMs: 100,
  });

  const dispatchOrder: Array<{ text: string; attachments: number }> = [];
  adapter.onMessage = async (msg) => {
    dispatchOrder.push({
      text: msg.text,
      attachments: msg.attachments?.length ?? 0,
    });
  };

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) throw new Error("Expected Slack message handler");

  // First message: debounced (no attachments).
  await handler({
    message: {
      channel: "D123",
      user: "U123",
      text: "first",
      ts: "1712800000.000001",
    },
  });
  await sleep(10);

  // Second message: has an attachment → bypass debounce. It should flush
  // the first (debounced) message before dispatching itself.
  resolveSlackInboundAttachmentsMock.mockImplementationOnce(async () => [
    {
      id: "F1",
      name: "file.pdf",
      mimeType: "application/pdf",
      kind: "file",
      localPath: "/tmp/file.pdf",
    },
  ]);
  await handler({
    message: {
      channel: "D123",
      user: "U123",
      text: "with file",
      ts: "1712800000.000002",
    },
  });

  // Wait a moment for the pre-flush and the immediate dispatch to settle.
  await sleep(30);

  expect(dispatchOrder).toEqual([
    { text: "first", attachments: 0 },
    { text: "with file", attachments: 1 },
  ]);
});

test("inbound debounce: message arrives first, then app_mention for same ts → single dispatch with mention", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
    inboundDebounceMs: 40,
  });

  const dispatched: Array<{ text: string; isMention: boolean }> = [];
  adapter.onMessage = async (msg) => {
    dispatched.push({ text: msg.text, isMention: msg.isMention === true });
  };

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const messageHandler = app?.messageHandler;
  const mentionHandler = app?.eventHandlers.get("app_mention");
  if (!messageHandler) throw new Error("Expected Slack message handler");
  if (!mentionHandler) throw new Error("Expected app_mention handler");

  // `message` arrives first for a threaded channel mention.
  await messageHandler({
    message: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> help",
      ts: "1712800000.000099",
      thread_ts: "1712800000.000099",
    },
  });
  // Same ts fires `app_mention` shortly after.
  await mentionHandler({
    event: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> help",
      ts: "1712800000.000099",
      thread_ts: "1712800000.000099",
    },
  });

  // Neither has dispatched yet — both sit inside the debounce window.
  expect(dispatched).toEqual([]);

  await sleep(80);

  // One combined dispatch; `isMention` is true.
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.isMention).toBe(true);
});

test("inbound debounce: app_mention arrives first, message-for-same-ts is dropped by dedupe", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
    inboundDebounceMs: 40,
  });

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const messageHandler = app?.messageHandler;
  const mentionHandler = app?.eventHandlers.get("app_mention");
  if (!messageHandler) throw new Error("Expected Slack message handler");
  if (!mentionHandler) throw new Error("Expected app_mention handler");

  // app_mention arrives first; `markIngressMessageSeen` records the ts.
  await mentionHandler({
    event: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> help",
      ts: "1712800000.000099",
      thread_ts: "1712800000.000099",
    },
  });
  // A followup `message` event for the same ts should be dropped — no retry
  // key was primed because app_mention doesn't prime.
  await messageHandler({
    message: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> help",
      ts: "1712800000.000099",
      thread_ts: "1712800000.000099",
    },
  });

  await sleep(80);

  expect(onMessage).toHaveBeenCalledTimes(1);
});
