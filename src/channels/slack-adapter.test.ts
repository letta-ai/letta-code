import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelMessageAttachment } from "@/channels/types";

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

type SlackCommandHandler = (args: {
  command: {
    command?: string;
    text?: string;
    user_id?: string;
    user_name?: string;
    channel_id?: string;
    channel_name?: string;
    trigger_id?: string;
  };
  ack: () => Promise<void>;
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
      update: mock(async () => ({ ts: "1712800000.000100" })),
    },
    assistant: {
      threads: {
        setStatus: mock(async () => ({ ok: true })),
      },
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
  commandHandlers = new Map<string, SlackCommandHandler>();
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

  command(name: string, handler: SlackCommandHandler): void {
    this.commandHandlers.set(name, handler);
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
    update: mock(async () => ({ ts: "1712800000.000100" })),
    startStream: mock(
      async (): Promise<{ ok: boolean; ts?: string; error?: string }> => ({
        ok: true,
        ts: "1712800000.000300",
      }),
    ),
    appendStream: mock(
      async (): Promise<{ ok: boolean; ts?: string; error?: string }> => ({
        ok: true,
        ts: "1712800000.000300",
      }),
    ),
    stopStream: mock(
      async (): Promise<{ ok: boolean; ts?: string; error?: string }> => ({
        ok: true,
        ts: "1712800000.000300",
      }),
    ),
  };
  readonly assistant = {
    threads: {
      setStatus: mock(async () => ({ ok: true })),
    },
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

mock.module("./slack/runtime", () => ({
  ensureSlackRuntimeInstalled: async () => false,
  installSlackRuntime: async () => {},
  isSlackRuntimeInstalled: () => true,
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

mock.module("./slack/media", () => ({
  resolveSlackChannelHistory: resolveSlackChannelHistoryMock,
  resolveSlackInboundAttachments: resolveSlackInboundAttachmentsMock,
  resolveSlackThreadStarter: resolveSlackThreadStarterMock,
  resolveSlackThreadHistory: resolveSlackThreadHistoryMock,
}));

const { createSlackAdapter, resolveSlackAccountDisplayName } = await import(
  "@/channels/slack/adapter"
);

const slackAccountDefaults = {
  accountId: "slack-test-account",
  displayName: "Test Workspace",
  agentId: null,
  defaultPermissionMode: "standard",
  createdAt: "2026-04-11T00:00:00.000Z",
  updatedAt: "2026-04-11T00:00:00.000Z",
} as const;

const originalFetch = globalThis.fetch;
const originalProgressThrottleEnv =
  process.env.LETTA_SLACK_PROGRESS_UPDATE_THROTTLE_MS;
const originalProgressKeepaliveEnv =
  process.env.LETTA_SLACK_PROGRESS_STREAM_KEEPALIVE_MS;
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
  process.env.LETTA_SLACK_PROGRESS_UPDATE_THROTTLE_MS = "0";
  process.env.LETTA_SLACK_PROGRESS_STREAM_KEEPALIVE_MS = "0";
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  for (const instance of FakeSlackApp.instances) {
    instance.client.auth.test.mockClear();
    instance.client.users.info.mockClear();
    instance.client.chat.postMessage.mockClear();
    instance.client.chat.update.mockClear();
    instance.client.assistant.threads.setStatus.mockClear();
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
    instance.chat.update.mockClear();
    instance.chat.startStream.mockClear();
    instance.chat.appendStream.mockClear();
    instance.chat.stopStream.mockClear();
    instance.assistant.threads.setStatus.mockClear();
    instance.reactions.add.mockClear();
    instance.reactions.remove.mockClear();
    instance.files.getUploadURLExternal.mockClear();
    instance.files.completeUploadExternal.mockClear();
  }
  if (originalProgressThrottleEnv === undefined) {
    delete process.env.LETTA_SLACK_PROGRESS_UPDATE_THROTTLE_MS;
  } else {
    process.env.LETTA_SLACK_PROGRESS_UPDATE_THROTTLE_MS =
      originalProgressThrottleEnv;
  }
  if (originalProgressKeepaliveEnv === undefined) {
    delete process.env.LETTA_SLACK_PROGRESS_STREAM_KEEPALIVE_MS;
  } else {
    process.env.LETTA_SLACK_PROGRESS_STREAM_KEEPALIVE_MS =
      originalProgressKeepaliveEnv;
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

test("slack adapter forwards native channel slash commands as channel slash input", async () => {
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
  const messages: unknown[] = [];
  adapter.onMessage = async (message) => {
    messages.push(message);
  };

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const handler = app?.commandHandlers.get("/cancel");
  if (!handler) {
    throw new Error("Expected /cancel command handler");
  }

  const ack = mock(async () => {});
  await handler({
    command: {
      command: "/cancel",
      text: "",
      user_id: "U123",
      user_name: "Alice",
      channel_id: "C123",
      channel_name: "eng",
      trigger_id: "trigger-1",
    },
    ack,
  });

  const modelHandler = app?.commandHandlers.get("/model");
  if (!modelHandler) {
    throw new Error("Expected /model command handler");
  }

  await modelHandler({
    command: {
      command: "/model",
      text: "openai/gpt-5",
      user_id: "U123",
      user_name: "Alice",
      channel_id: "C123",
      channel_name: "eng",
      trigger_id: "trigger-2",
    },
    ack,
  });

  expect(ack).toHaveBeenCalledTimes(2);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    senderId: "U123",
    senderName: "Alice",
    chatLabel: "eng",
    text: "/cancel",
    messageId: "trigger-1",
    threadId: null,
    chatType: "channel",
  });
  expect(messages[1]).toMatchObject({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    senderId: "U123",
    senderName: "Alice",
    chatLabel: "eng",
    text: "/model openai/gpt-5",
    messageId: "trigger-2",
    threadId: null,
    chatType: "channel",
  });
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

test("slack adapter does not thread direct messages from reply metadata alone", async () => {
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
    chatId: "D123",
    text: "hello dm",
    replyToMessageId: "1712800000.000201",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "D123",
    text: "hello dm",
  });
});

test("slack adapter preserves explicit direct message threads", async () => {
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
    chatId: "D123",
    text: "hello dm thread",
    threadId: "1712800000.000200",
    replyToMessageId: "1712800000.000201",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "D123",
    text: "hello dm thread",
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

test("slack adapter sendDirectReply does not thread direct messages", async () => {
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
  await adapter.sendDirectReply("D123", "reply text", {
    replyToMessageId: "1712800000.000200",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "D123",
    text: "reply text",
  });
});

test("slack adapter sendDirectReply preserves explicit direct message threads", async () => {
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
  await adapter.sendDirectReply("D123", "reply text", {
    replyToMessageId: "1712800000.000201",
    threadId: "1712800000.000100",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "D123",
    text: "reply text",
    thread_ts: "1712800000.000100",
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
      threadId: null,
      chatType: "direct",
    }),
  );
});

test("slack adapter forwards threaded DM replies with explicit thread metadata", async () => {
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
      text: "hello from slack thread",
      ts: "1712800000.000101",
      thread_ts: "1712800000.000100",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "D123",
      senderId: "U123",
      text: "hello from slack thread",
      messageId: "1712800000.000101",
      threadId: "1712800000.000100",
      chatType: "direct",
    }),
  );
});

test("slack adapter normalizes mentioned DM text", async () => {
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
      text: "<@U0AS42PTEAX>!help",
      ts: "1712800000.000100",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "D123",
      senderId: "U123",
      text: "!help",
      messageId: "1712800000.000100",
      chatType: "direct",
      isMention: true,
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
      text: "<@U0AS42PTEAX>!help",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "!help",
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
  expect(resolveSlackThreadHistoryMock).toHaveBeenCalledTimes(1);
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

  resolveSlackThreadHistoryMock.mockResolvedValueOnce([
    {
      text: "Already-delivered human context",
      userId: "U222",
      ts: "1712795000.000060",
    },
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

test("slack adapter passes transcription opt-in to message and app_mention media resolution", async () => {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
    transcribeVoice: true,
  });

  adapter.onMessage = mock(async () => {});

  await adapter.start();
  const app = FakeSlackApp.instances[0];
  const messageHandler = app?.messageHandler;
  const mentionHandler = app?.eventHandlers.get("app_mention");
  if (!messageHandler || !mentionHandler) {
    throw new Error("Expected Slack handlers");
  }

  await messageHandler({
    message: {
      channel: "D123",
      user: "U123",
      text: "voice note",
      ts: "1712800000.000100",
    },
  });
  await mentionHandler({
    event: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> voice note",
      ts: "1712800000.000101",
    },
  });

  expect(resolveSlackInboundAttachmentsMock).toHaveBeenCalledTimes(2);
  expect(resolveSlackInboundAttachmentsMock).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      accountId: "slack-test-account",
      token: "xoxb-test-token-1234567890",
      rawEvent: expect.objectContaining({ channel: "D123" }),
      transcribeVoice: true,
    }),
  );
  expect(resolveSlackInboundAttachmentsMock).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      accountId: "slack-test-account",
      token: "xoxb-test-token-1234567890",
      rawEvent: expect.objectContaining({ channel: "C123" }),
      transcribeVoice: true,
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

test("slack adapter ignores live bot_message events as runnable input", async () => {
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
      bot_id: "BDEPLOY",
      text: "deployment completed",
      ts: "1712800000.000103",
      thread_ts: "1712790000.000050",
      subtype: "bot_message",
    },
  });

  expect(onMessage).not.toHaveBeenCalled();
  expect(resolveSlackInboundAttachmentsMock).not.toHaveBeenCalled();
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

test("slack adapter ignores reactions authored by its own bot user", async () => {
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
  const reactionAddedHandler = app?.eventHandlers.get("reaction_added");
  const reactionRemovedHandler = app?.eventHandlers.get("reaction_removed");
  if (!reactionAddedHandler || !reactionRemovedHandler) {
    throw new Error("Expected Slack reaction handlers");
  }

  const event = {
    user: "U0AS42PTEAX",
    item_user: "U123",
    reaction: "x",
    event_ts: "1712800001.000200",
    item: {
      type: "message",
      channel: "C123",
      ts: "1712800000.000100",
    },
  };

  await reactionAddedHandler({ event });
  await reactionRemovedHandler({ event });

  expect(onMessage).not.toHaveBeenCalled();
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

test("slack adapter does not add lifecycle reactions for rich progress turns", async () => {
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
  expect(writeClient?.reactions.add.mock.calls ?? []).toHaveLength(0);
  expect(writeClient?.reactions.remove.mock.calls ?? []).toHaveLength(0);
});

test("slack adapter streams native task progress and clears thread status", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source,
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Preparing <tool> @channel & token=abc",
    toolCallId: "call-1",
    toolName: "shell_exec",
  });
  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(1);
  expect(writeClient?.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712790000.000050",
    status: "",
  });
  expect(writeClient?.chat.appendStream).not.toHaveBeenCalled();
  expect(writeClient?.chat.stopStream).not.toHaveBeenCalled();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "completed",
    message: "Tool finished",
    toolCallId: "call-1",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [source],
  });

  expect(writeClient?.chat.postMessage).not.toHaveBeenCalled();
  expect(writeClient?.chat.update).not.toHaveBeenCalled();
  expect(writeClient?.chat.startStream).toHaveBeenCalledWith({
    channel: "C123",
    thread_ts: "1712790000.000050",
    task_display_mode: "plan",
    recipient_user_id: "U123",
    recipient_team_id: "T123",
    chunks: [
      {
        type: "plan_update",
        title: "Running",
      },
      {
        type: "task_update",
        id: "task_call-1",
        title: "Running",
        status: "in_progress",
      },
    ],
  });
  expect(writeClient?.chat.appendStream).toHaveBeenCalledTimes(1);
  const appendCalls = writeClient?.chat.appendStream.mock
    .calls as unknown as Array<
    [
      {
        channel: string;
        ts: string;
        markdown_text?: string;
        chunks?: Array<Record<string, unknown>>;
      },
    ]
  >;
  const appendCall = appendCalls[0]?.[0];
  expect(appendCall).toMatchObject({
    channel: "C123",
    ts: "1712800000.000300",
  });
  expect(appendCall?.chunks?.[0]).toMatchObject({
    type: "plan_update",
    title: "Working",
  });
  expect(appendCall?.chunks?.[1]).toMatchObject({
    type: "task_update",
    id: "task_call-1",
    title: "Ran",
    status: "complete",
  });
  expect(JSON.stringify(appendCall?.chunks)).not.toContain("token=abc");
  expect(writeClient?.chat.stopStream).not.toHaveBeenCalled();
  expect(writeClient?.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712790000.000050",
    status: "",
  });
});

test("slack adapter labels subagent task rows and includes prompt previews", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Preparing subagent",
    toolCallId: "call-agent",
    toolName: "Agent",
    toolDetails:
      "Review Slack live feedback with TOKEN=secret and do not ping @channel <packet>",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream).toHaveBeenCalledWith({
    channel: "C123",
    thread_ts: "1712790000.000050",
    task_display_mode: "plan",
    recipient_user_id: "U123",
    recipient_team_id: "T123",
    chunks: [
      {
        type: "plan_update",
        title: "Subagent",
      },
      {
        type: "task_update",
        id: "task_call-agent",
        title: "Subagent",
        status: "in_progress",
        details:
          "Review Slack live feedback with TOKEN=[redacted] and do not ping @​channel packet",
      },
    ],
  });
});

test("slack adapter updates Skill task title when the loaded skill arrives", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Preparing tool: Skill",
    toolCallId: "call-skill",
    toolName: "Skill",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Preparing tool: Skill",
    toolCallId: "call-skill",
    toolName: "Skill",
    toolTitle: "Skill: working-on-letta-code-channels",
    toolDetails: "working-on-letta-code-channels",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream).toHaveBeenCalledWith({
    channel: "C123",
    thread_ts: "1712790000.000050",
    task_display_mode: "plan",
    recipient_user_id: "U123",
    recipient_team_id: "T123",
    chunks: [
      {
        type: "plan_update",
        title: "Skill",
      },
      {
        type: "task_update",
        id: "task_call-skill",
        title: "Skill",
        status: "in_progress",
      },
    ],
  });
  expect(writeClient?.chat.appendStream).toHaveBeenCalledWith({
    channel: "C123",
    ts: "1712800000.000300",
    chunks: expect.arrayContaining([
      expect.objectContaining({
        type: "task_update",
        id: "task_call-skill",
        title: "Skill: working-on-letta-code-channels",
        status: "in_progress",
        details: "working-on-letta-code-channels",
      }),
    ]),
  });
});

test("slack adapter keeps rendered task details stable", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Preparing tool",
    toolCallId: "call-1",
    toolName: "exec_command",
    toolDetails: "find locales -type f",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Preparing tool",
    toolCallId: "call-1",
    toolName: "exec_command",
    toolDetails: "Inspect changed translation files",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream).toHaveBeenCalledWith({
    channel: "C123",
    thread_ts: "1712790000.000050",
    task_display_mode: "plan",
    recipient_user_id: "U123",
    recipient_team_id: "T123",
    chunks: [
      {
        type: "plan_update",
        title: "Running",
      },
      {
        type: "task_update",
        id: "task_call-1",
        title: "Running",
        status: "in_progress",
        details: "find locales -type f",
      },
    ],
  });
  expect(writeClient?.chat.appendStream).not.toHaveBeenCalled();
});

test("slack adapter keeps reasoning updates out of concrete task rows", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-read",
    toolName: "read_file",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "completed",
    message: "Read files",
    toolCallId: "call-read",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "thinking",
    state: "updated",
    message: "Thinking",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Running command",
    toolCallId: "call-bash",
    toolName: "exec_command",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [source],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  const startCalls = writeClient?.chat.startStream.mock
    .calls as unknown as Array<[{ chunks?: Array<Record<string, unknown>> }]>;
  const appendCalls = writeClient?.chat.appendStream.mock
    .calls as unknown as Array<[{ chunks?: Array<Record<string, unknown>> }]>;
  const stopCalls = writeClient?.chat.stopStream.mock.calls as unknown as Array<
    [{ chunks?: Array<Record<string, unknown>> }]
  >;
  expect(appendCalls.map(([call]) => call.chunks)).toEqual(
    expect.arrayContaining([
      [
        {
          type: "plan_update",
          title: "Thinking",
        },
      ],
      expect.arrayContaining([
        expect.objectContaining({
          id: "task_call-bash",
          title: "Running",
          status: "in_progress",
        }),
      ]),
    ]),
  );
  const streamedChunks = [
    ...startCalls.flatMap(([call]) => call.chunks ?? []),
    ...appendCalls.flatMap(([call]) => call.chunks ?? []),
    ...stopCalls.flatMap(([call]) => call.chunks ?? []),
  ];
  expect(streamedChunks).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: expect.stringMatching(/^task_reasoning/) }),
    ]),
  );
  expect(streamedChunks).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ title: "Finished" }),
      expect.objectContaining({ title: "Thought" }),
    ]),
  );
});

test("slack adapter anchors direct message progress to the inbound message", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "D123",
    chatType: "direct" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-1",
    toolName: "read_file",
  });
  await adapter.sendMessage({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "D123",
    text: "Done in the DM.",
    replyToMessageId: "1712800000.000100",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  const statusCalls =
    (writeClient?.assistant.threads.setStatus.mock.calls as Array<
      Array<{
        channel_id: string;
        thread_ts: string;
        status: string;
      }>
    >) ?? [];
  expect(statusCalls[0]?.[0]).toMatchObject({
    channel_id: "D123",
    thread_ts: "1712800000.000100",
  });
  expect(["is cogitating...", "is thinking...", "is processing..."]).toContain(
    statusCalls[0]?.[0]?.status ?? "",
  );
  expect(writeClient?.chat.startStream).toHaveBeenCalledWith({
    channel: "D123",
    thread_ts: "1712800000.000100",
    task_display_mode: "plan",
    chunks: [
      {
        type: "plan_update",
        title: "Read",
      },
      {
        type: "task_update",
        id: "task_call-1",
        title: "Read",
        status: "in_progress",
      },
    ],
  });
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "D123",
    text: "Done in the DM.",
  });
  expect(writeClient?.chat.stopStream).toHaveBeenCalledWith({
    channel: "D123",
    ts: "1712800000.000300",
    chunks: [
      {
        type: "task_update",
        id: "task_call-1",
        title: "Read",
        status: "complete",
      },
      {
        type: "plan_update",
        title: "Completed",
      },
    ],
  });
  expect(writeClient?.chat.appendStream).not.toHaveBeenCalled();
  expect(writeClient?.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "D123",
    thread_ts: "1712800000.000100",
    status: "",
  });
});

test("slack adapter keeps separate task rows for parallel tool progress", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Searching web",
    toolCallId: "call-web",
    toolName: "web_search",
    toolTitle: "Searching articles",
    toolDetails: "letta blog",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Running command",
    toolCallId: "call-bash",
    toolName: "exec_command",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading file",
    toolCallId: "call-read",
    toolName: "read_file",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "completed",
    message: "Tool finished",
    toolCallId: "call-bash",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [source],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream).toHaveBeenCalledWith(
    expect.objectContaining({
      task_display_mode: "plan",
      chunks: [
        expect.objectContaining({
          type: "plan_update",
          title: "Searching articles",
        }),
        expect.objectContaining({
          id: "task_call-web",
          title: "Searching articles",
          details: "letta blog",
          status: "in_progress",
        }),
      ],
    }),
  );
  const appendCalls = writeClient?.chat.appendStream.mock
    .calls as unknown as Array<[{ chunks?: Array<Record<string, unknown>> }]>;
  const appendChunks = appendCalls.flatMap(([call]) => call.chunks ?? []);
  const runningTwoAppend = appendCalls.find(([call]) =>
    call.chunks?.some(
      (chunk) =>
        chunk.type === "plan_update" && chunk.title === "Running 2 tools",
    ),
  )?.[0];
  expect(runningTwoAppend?.chunks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "task_call-bash",
        title: "Running",
      }),
    ]),
  );
  expect(appendChunks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "plan_update",
        title: "Running 2 tools",
      }),
      expect.objectContaining({
        type: "plan_update",
        title: "Running 3 tools",
      }),
      expect.objectContaining({
        id: "task_call-bash",
        title: "Running",
        status: "in_progress",
      }),
      expect.objectContaining({
        id: "task_call-read",
        title: "Read",
        status: "in_progress",
      }),
      expect.objectContaining({
        id: "task_call-bash",
        title: "Ran",
        status: "complete",
      }),
      expect.objectContaining({
        type: "plan_update",
        title: "Running 2 tools",
      }),
    ]),
  );
  expect(writeClient?.chat.stopStream).not.toHaveBeenCalled();
});

test("slack adapter renders approval progress without thread status noise", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "approval",
    state: "waiting",
    message: "Waiting for approval: memory_apply_patch",
    toolCallId: "approval-1",
    toolName: "memory_apply_patch",
    toolDetails: "Input: too much detail",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.assistant.threads.setStatus).not.toHaveBeenCalled();
  expect(writeClient?.chat.startStream).toHaveBeenCalledWith({
    channel: "C123",
    thread_ts: "1712790000.000050",
    task_display_mode: "plan",
    recipient_user_id: "U123",
    recipient_team_id: "T123",
    chunks: [
      {
        type: "plan_update",
        title: "Approval needed",
      },
      {
        type: "task_update",
        id: "task_approval-1",
        title: "Approval needed: Memory",
        status: "pending",
      },
    ],
  });
});

test("slack adapter posts generic approval prompts as compact cards", async () => {
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
  await adapter.handleControlRequestEvent?.({
    requestId: "approval-1",
    kind: "generic_tool_approval",
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
    toolName: "memory_apply_patch",
    input: { reason: "Update memory", input: "*** Begin Patch..." },
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    thread_ts: "1712790000.000050",
    text: expect.stringContaining(
      "The agent wants approval to run `memory_apply_patch`.",
    ),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Approval needed*\nRun `Memory`?",
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Reply `approve` to allow it, or reply with feedback to deny.",
          },
        ],
      },
    ],
  });
});

test("slack adapter does not create fallback cards after stream append failure", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-1",
    toolName: "read_file",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  writeClient?.chat.appendStream.mockImplementation(async () => ({
    ok: false,
    error: "stream_closed",
  }));

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Searching files",
    toolCallId: "call-2",
    toolName: "grep",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Running shell",
    toolCallId: "call-3",
    toolName: "shell",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [source],
  });

  expect(writeClient?.chat.postMessage).not.toHaveBeenCalled();
  expect(writeClient?.chat.update).not.toHaveBeenCalled();

  await adapter.sendMessage({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    text: "Done.",
    threadId: "1712790000.000050",
  });

  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.appendStream).toHaveBeenCalled();
  expect(writeClient?.chat.stopStream).toHaveBeenCalledTimes(1);
  const stopCalls = writeClient?.chat.stopStream.mock.calls as unknown as Array<
    Array<{ channel: string; ts: string; chunks?: unknown[] }>
  >;
  const stopArgs = stopCalls[0]?.[0];
  expect(stopArgs).toMatchObject({
    channel: "C123",
    ts: "1712800000.000300",
  });
  expect(stopArgs?.chunks).toEqual(
    expect.arrayContaining([
      {
        type: "task_update",
        id: "task_call-1",
        title: "Read",
        status: "complete",
      },
      {
        type: "task_update",
        id: "task_call-2",
        title: "Search",
        status: "complete",
      },
      {
        type: "task_update",
        id: "task_call-3",
        title: "Ran",
        status: "complete",
      },
      {
        type: "plan_update",
        title: "Completed",
      },
    ]),
  );
  expect(writeClient?.chat.postMessage).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.update).not.toHaveBeenCalled();
});

test("slack adapter keeps active progress streams alive during long tool gaps", async () => {
  process.env.LETTA_SLACK_PROGRESS_STREAM_KEEPALIVE_MS = "5";
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-1",
    toolName: "read_file",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  await sleep(20);

  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.appendStream).toHaveBeenCalledWith({
    channel: "C123",
    ts: "1712800000.000300",
    chunks: [
      {
        type: "plan_update",
        title: "Read",
      },
    ],
  });

  await adapter.stop();
});

test("slack adapter does not immediately retry failed progress stream starts", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });
  const writeClient = FakeSlackWriteClient.instances[0];
  writeClient?.chat.startStream.mockResolvedValue({
    ok: false,
    error: "not_allowed",
  });

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-1",
    toolName: "read_file",
  });

  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.appendStream).not.toHaveBeenCalled();
  expect(writeClient?.chat.postMessage).not.toHaveBeenCalled();
  expect(writeClient?.chat.update).not.toHaveBeenCalled();
});

test("slack adapter keeps one active progress card slot until finalized", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-1",
    toolName: "read_file",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-2",
    sources: [{ ...source, messageId: "1712800001.000100" }],
    kind: "tool",
    state: "started",
    message: "Searching web",
    toolCallId: "call-2",
    toolName: "web_search",
    toolTitle: "Search the web",
    toolDetails: "letta slack progress cards",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.appendStream).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.appendStream).toHaveBeenCalledWith({
    channel: "C123",
    ts: "1712800000.000300",
    chunks: expect.arrayContaining([
      expect.objectContaining({
        id: "task_call-2",
        title: "Searching the web",
        details: "letta slack progress cards",
        status: "in_progress",
      }),
    ]),
  });
});

test("slack adapter keeps progress cards active across completed continuation lifecycles", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-1",
    toolName: "read_file",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-2",
    sources: [{ ...source, messageId: "1712800001.000100" }],
    kind: "tool",
    state: "started",
    message: "Searching files",
    toolCallId: "call-2",
    toolName: "grep",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.stopStream).not.toHaveBeenCalled();
  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.appendStream).toHaveBeenCalledWith({
    channel: "C123",
    ts: "1712800000.000300",
    chunks: expect.arrayContaining([
      expect.objectContaining({
        id: "task_call-2",
        title: "Search",
        status: "in_progress",
      }),
    ]),
  });

  await adapter.sendMessage({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    text: "Done.",
    threadId: "1712790000.000050",
  });

  expect(writeClient?.chat.stopStream).toHaveBeenCalledTimes(1);

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-3",
    sources: [{ ...source, messageId: "1712800002.000100" }],
    kind: "tool",
    state: "started",
    message: "Reading again",
    toolCallId: "call-3",
    toolName: "read_file",
  });

  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(2);
});

test("slack adapter treats already-closed stream stop errors as benign", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-1",
    toolName: "read_file",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  writeClient?.chat.stopStream.mockResolvedValueOnce({
    ok: false,
    error: "message_not_in_streaming_state",
  });

  await adapter.sendMessage({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    text: "Done.",
    threadId: "1712790000.000050",
  });

  expect(writeClient?.chat.stopStream).toHaveBeenCalledWith({
    channel: "C123",
    ts: "1712800000.000300",
    chunks: expect.arrayContaining([
      expect.objectContaining({
        id: "task_call-1",
        title: "Read",
        status: "complete",
      }),
      expect.objectContaining({
        type: "plan_update",
        title: "Completed",
      }),
    ]),
  });
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "Done.",
    thread_ts: "1712790000.000050",
  });
  expect(writeClient?.chat.update).not.toHaveBeenCalled();
});

test("slack adapter includes final error details in rich progress streams", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Reading files",
    toolCallId: "call-1",
    toolName: "read_file",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "error",
    error:
      "Boom TOKEN=abc <payload> @channel & friends\nView agent: https://app.letta.com/chat/secret",
    sources: [source],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.stopStream).toHaveBeenCalledWith({
    channel: "C123",
    ts: "1712800000.000300",
    chunks: expect.arrayContaining([
      expect.objectContaining({
        id: "task_call-1",
        title: "Read",
        status: "error",
      }),
      expect.objectContaining({
        type: "task_update",
        id: "task_lifecycle_error",
        title: "Turn failed",
        status: "error",
        details: "Boom TOKEN=[redacted] payload @\u200bchannel and friends",
      }),
      expect.objectContaining({
        type: "plan_update",
        title: "Failed",
      }),
    ]),
  });
  expect(JSON.stringify(writeClient?.chat.stopStream.mock.calls)).not.toContain(
    "app.letta.com",
  );
});

test("slack adapter keeps failed tool rows from failing completed progress streams", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Running command",
    toolCallId: "call-bash",
    toolName: "bash",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "error",
    message: "Command exited 1",
    toolCallId: "call-bash",
    toolName: "bash",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [source],
  });
  await adapter.sendMessage({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    text: "Done — command status was expected.",
    threadId: "1712790000.000050",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.stopStream).toHaveBeenCalledTimes(1);
  const stopCalls = writeClient?.chat.stopStream.mock.calls as unknown as Array<
    [{ chunks?: Array<Record<string, unknown>> }]
  >;
  const stopCall = stopCalls[0]?.[0];
  expect(stopCall?.chunks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "task_update",
        id: "task_call-bash",
        title: "Running",
        status: "error",
      }),
      expect.objectContaining({
        type: "plan_update",
        title: "Completed",
      }),
    ]),
  );
  expect(stopCall?.chunks).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "plan_update",
        title: "Failed",
      }),
    ]),
  );
});

test("slack adapter shows a progress card while a no-tool turn is running", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source,
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [source],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream).not.toHaveBeenCalled();
  expect(writeClient?.chat.postMessage).not.toHaveBeenCalled();
  expect(writeClient?.chat.update).not.toHaveBeenCalled();
  const statusCalls =
    (writeClient?.assistant.threads.setStatus.mock.calls as Array<
      Array<{ status: string }>
    >) ?? [];
  expect(statusCalls.length).toBeGreaterThanOrEqual(3);
  const firstStatus = statusCalls[0]?.[0]?.status;
  const secondStatus = statusCalls[1]?.[0]?.status;
  expect(["is cogitating...", "is thinking...", "is processing..."]).toContain(
    firstStatus ?? "",
  );
  expect(secondStatus).toBe(firstStatus);
  expect(statusCalls[statusCalls.length - 1]?.[0]?.status).toBe("");
});

test("slack adapter finishes an active progress card when MessageChannel sends", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Searching web",
    toolCallId: "call-web",
    toolName: "web_search",
    toolTitle: "Searching articles",
    toolDetails: "letta blog",
  });
  await adapter.sendMessage({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    text: "Done — found it.",
    threadId: "1712790000.000050",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "Done — found it.",
    thread_ts: "1712790000.000050",
  });
  expect(writeClient?.chat.stopStream).toHaveBeenCalledWith({
    channel: "C123",
    ts: "1712800000.000300",
    chunks: expect.arrayContaining([
      expect.objectContaining({
        id: "task_call-web",
        title: "Searched articles",
        status: "complete",
      }),
      expect.objectContaining({
        type: "plan_update",
        title: "Completed",
      }),
    ]),
  });

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-2",
    sources: [{ ...source, messageId: "1712800001.000100" }],
    kind: "tool",
    state: "started",
    message: "Reading again",
    toolCallId: "call-read",
    toolName: "read_file",
  });

  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(2);
});

test("slack adapter shows responding while MessageChannel runs with an active progress card", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Searching web",
    toolCallId: "call-web",
    toolName: "web_search",
    toolTitle: "Searching articles",
    toolDetails: "letta blog",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "completed",
    message: "Tool finished",
    toolCallId: "call-web",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Preparing tool: MessageChannel",
    toolCallId: "call-message-channel",
    toolName: "MessageChannel",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.appendStream).toHaveBeenCalledTimes(2);
  const appendCalls = writeClient?.chat.appendStream.mock
    .calls as unknown as Array<
    [
      {
        channel: string;
        ts: string;
        chunks?: Array<Record<string, unknown>>;
      },
    ]
  >;
  const respondingAppend = appendCalls[1]?.[0];
  expect(respondingAppend).toMatchObject({
    channel: "C123",
    ts: "1712800000.000300",
  });
  expect(respondingAppend?.chunks).toEqual([
    {
      type: "plan_update",
      title: "Responding",
    },
    {
      type: "task_update",
      id: "task_channel_response",
      title: "Responding",
      status: "in_progress",
    },
  ]);

  await adapter.sendMessage({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    text: "Done — found it.",
    threadId: "1712790000.000050",
  });

  expect(writeClient?.chat.stopStream).toHaveBeenCalledWith({
    channel: "C123",
    ts: "1712800000.000300",
    chunks: expect.arrayContaining([
      expect.objectContaining({
        id: "task_channel_response",
        title: "Responded",
        status: "complete",
      }),
      expect.objectContaining({
        type: "plan_update",
        title: "Completed",
      }),
    ]),
  });
});

test("slack adapter suppresses internal channel delivery tools from progress cards", async () => {
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
  const source = {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel" as const,
    messageId: "1712800000.000100",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  await adapter.start();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolCallId: "call-message-channel",
    toolName: "MessageChannel",
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    batchId: "batch-1",
    sources: [source],
    kind: "tool",
    state: "completed",
    message: "Tool finished",
    toolCallId: "call-message-channel",
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    outcome: "completed",
    sources: [source],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.startStream.mock.calls ?? []).toHaveLength(0);
  expect(writeClient?.chat.postMessage.mock.calls ?? []).toHaveLength(0);
  expect(writeClient?.chat.update.mock.calls ?? []).toHaveLength(0);
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
  expect(writeClient?.reactions.add).not.toHaveBeenCalled();
  expect(writeClient?.reactions.remove).not.toHaveBeenCalled();
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "Turn failed:\n```\nBoom: something went wrong\nsecond line\n```",
    thread_ts: "1712790000.000050",
  });
});

test("slack adapter posts lifecycle errors in direct messages without threading", async () => {
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
    batchId: "batch-dm-error",
    outcome: "error",
    error: "DM failure",
    sources: [
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "D123",
        chatType: "direct",
        messageId: "1712800000.000300",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "D123",
        chatType: "direct",
        messageId: "1712800000.000301",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(
    writeClient?.assistant.threads.setStatus.mock.calls ?? [],
  ).toHaveLength(0);
  expect(writeClient?.chat.postMessage).toHaveBeenCalledTimes(1);
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "D123",
    text: "Turn failed:\n```\nDM failure\n```",
  });
});

test("slack adapter posts lifecycle errors into explicit direct message threads", async () => {
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
    batchId: "batch-dm-thread-error",
    outcome: "error",
    error: "Thread failure",
    sources: [
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "D123",
        chatType: "direct",
        messageId: "1712800000.000301",
        threadId: "1712800000.000100",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "D123",
    text: "Turn failed:\n```\nThread failure\n```",
    thread_ts: "1712800000.000100",
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

test("slack adapter hides raw generic lifecycle errors", async () => {
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
    batchId: "batch-raw-error",
    outcome: "error",
    error: "Unexpected stop reason: error",
    sources: [
      {
        channel: "slack",
        accountId: "slack-test-account",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000501",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ],
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "Turn failed:\n```\nSomething went wrong while processing that message. Please try again.\n```",
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
  expect(writeClient?.chat.postMessage.mock.calls ?? []).toHaveLength(0);
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
