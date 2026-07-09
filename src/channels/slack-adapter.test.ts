import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSlackModelPickerBlocks } from "@/channels/slack/model-picker-blocks";
import type {
  ChannelMessageAttachment,
  ChannelTurnSource,
  SlackChannelAccount,
} from "@/channels/types";

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

type SlackActionHandler = (args: {
  body: unknown;
  action: unknown;
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
  actionHandlers = new Map<string, SlackActionHandler>();
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

  action(name: string, handler: SlackActionHandler): void {
    this.actionHandlers.set(name, handler);
  }

  error(handler: (error: Error) => Promise<void>): void {
    this.errorHandler = handler;
  }
}

class FakeSlackWriteClient {
  static instances: FakeSlackWriteClient[] = [];
  static setStatusHandler:
    | ((args: Record<string, unknown>) => Promise<{ ok: boolean }>)
    | null = null;
  /** Simulates a Slack client/workspace without chat.startStream support. */
  static disableStartStream = false;

  readonly token: string;
  readonly options: Record<string, unknown> | undefined;
  /** Stream content mode per stream ts, mirroring the live API contract. */
  readonly streamModesByTs = new Map<string, "chunks" | "markdown_text">();
  /** Opt-in: mint a distinct ts per started stream (for roll tests). */
  static distinctStreamTs = false;
  startStreamCount = 0;
  readonly chat = {
    postMessage: mock(async () => ({ ts: "1712800000.000100" })),
    update: mock(async () => ({ ts: "1712800000.000100" })),
    delete: mock(async () => ({ ok: true })),
    startStream: mock(
      async (args?: {
        markdown_text?: string;
        chunks?: unknown[];
      }): Promise<{ ok: boolean; ts?: string; error?: string }> => {
        this.startStreamCount += 1;
        const ts =
          FakeSlackWriteClient.distinctStreamTs && this.startStreamCount > 1
            ? `1712800000.00030${this.startStreamCount - 1}`
            : "1712800000.000300";
        this.streamModesByTs.set(
          ts,
          Array.isArray(args?.chunks) && args.chunks.length > 0
            ? "chunks"
            : "markdown_text",
        );
        return { ok: true, ts };
      },
    ),
    appendStream: mock(
      async (): Promise<{ ok: boolean; ts?: string; error?: string }> => ({
        ok: true,
        ts: "1712800000.000300",
      }),
    ),
    stopStream: mock(
      async (args?: {
        ts?: string;
        markdown_text?: string;
        chunks?: unknown[];
      }): Promise<{ ok: boolean; ts?: string; error?: string }> => {
        // Pin the real Slack wire contract: chat.stopStream rejects
        // markdown_text combined with chunks (verified live 2026-07-07).
        // Sending both silently broke every terminal card close in prod
        // while the previous accept-anything mock kept tests green.
        if (
          typeof args?.markdown_text === "string" &&
          Array.isArray(args?.chunks) &&
          args.chunks.length > 0
        ) {
          return {
            ok: false,
            error: "cannot_provide_both_markdown_text_and_chunks",
          };
        }
        // Also pin streaming_mode_mismatch: a stream started with chunks
        // cannot stop with top-level markdown_text (verified live
        // 2026-07-08); final text must ride as a markdown_text CHUNK.
        if (
          typeof args?.markdown_text === "string" &&
          args?.ts &&
          this.streamModesByTs.get(args.ts) === "chunks"
        ) {
          return { ok: false, error: "streaming_mode_mismatch" };
        }
        return {
          ok: true,
          ts: "1712800000.000300",
        };
      },
    ),
  };
  readonly assistant = {
    threads: {
      setStatus: mock(async (args: Record<string, unknown>) => {
        if (FakeSlackWriteClient.setStatusHandler) {
          return FakeSlackWriteClient.setStatusHandler(args);
        }
        return { ok: true };
      }),
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
    if (FakeSlackWriteClient.disableStartStream) {
      (this.chat as { startStream?: unknown }).startStream = undefined;
    }
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
    attachments?: ChannelMessageAttachment[];
  } | null> => null,
);
const resolveSlackThreadHistoryMock = mock(
  async (): Promise<
    Array<{
      text: string;
      userId?: string;
      botId?: string;
      ts?: string;
      attachments?: ChannelMessageAttachment[];
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
      attachments?: ChannelMessageAttachment[];
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
const fetchMock = mock(
  async () =>
    new Response("uploaded", {
      status: 200,
    }),
);

beforeEach(() => {
  FakeSlackApp.instances.length = 0;
  FakeSlackWriteClient.instances.length = 0;
  FakeSlackWriteClient.disableStartStream = false;
  FakeSlackWriteClient.distinctStreamTs = false;
  FakeSlackWriteClient.setStatusHandler = null;
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
    instance.chat.startStream?.mockClear();
    instance.chat.appendStream.mockClear();
    instance.chat.stopStream.mockClear();
    instance.assistant.threads.setStatus.mockClear();
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

test("slack adapter forwards model picker selections as /model commands", async () => {
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
  const handler = app?.actionHandlers.get("letta_channel_model_select");
  if (!handler) {
    throw new Error("Expected model select action handler");
  }

  const ack = mock(async () => {});
  await handler({
    body: {
      user: { id: "U123", name: "Alice", team_id: "T123" },
      channel: { id: "C123", name: "eng" },
      container: {
        channel_id: "C123",
        message_ts: "1712800000.000100",
        thread_ts: "1712800000.000200",
      },
      message: { ts: "1712800000.000100", thread_ts: "1712800000.000200" },
    },
    action: {
      action_id: "letta_channel_model_select",
      action_ts: "1712800001.000300",
      selected_option: {
        value: "openai/gpt-5",
      },
    },
    ack,
  });

  expect(ack).toHaveBeenCalledTimes(1);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    senderId: "U123",
    senderName: "Alice",
    senderTeamId: "T123",
    text: "/model openai/gpt-5",
    threadId: "1712800000.000200",
    chatType: "channel",
  });
});

test("slack adapter renders model picker blocks on direct replies", async () => {
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
  const modelPicker = {
    current: {
      modelLabel: "Auto",
      modelHandle: "letta/auto",
      scope: "conversation" as const,
    },
    entries: [
      {
        id: "auto",
        handle: "letta/auto",
        label: "Auto",
        description: "Recommended default",
        isDefault: true,
      },
    ],
    availableHandles: ["letta/auto"],
    recentHandles: [],
  };

  await adapter.start();
  await adapter.sendDirectReply(
    "C123",
    "Slack current conversation model: Auto.",
    {
      threadId: "1712800000.000200",
      modelPicker,
    },
  );

  const writeClient = FakeSlackWriteClient.instances[0];
  expect(writeClient?.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "Slack current conversation model: Auto.",
    blocks: buildSlackModelPickerBlocks(modelPicker),
    thread_ts: "1712800000.000200",
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

test("slack adapter auto-routes unmentioned replies in agent-participated threads", async () => {
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
  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "agent reply",
    threadId: "1712790000.000050",
  });

  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) {
    throw new Error("Expected Slack message handler");
  }

  await handler({
    message: {
      channel: "C123",
      user: "U123",
      text: "<@UOTHER> can you check this?",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "<@UOTHER> can you check this?",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: true,
    }),
  );
});

test("slack adapter scopes agent-thread auto-routing by channel", async () => {
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
  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "agent reply",
    threadId: "1712790000.000050",
  });

  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) {
    throw new Error("Expected Slack message handler");
  }

  await handler({
    message: {
      channel: "C999",
      user: "U123",
      text: "same timestamp, different channel",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C999",
      text: "same timestamp, different channel",
      threadId: "1712790000.000050",
      isMention: false,
    }),
  );
});

test("slack adapter auto-routes replies after threaded file uploads", async () => {
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

  const onMessage = mock(async () => {});
  adapter.onMessage = onMessage;

  await adapter.start();
  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "latest chart",
    mediaPath,
    fileName: "chart.png",
    title: "Chart",
    threadId: "1712790000.000050",
  });

  const app = FakeSlackApp.instances[0];
  const handler = app?.messageHandler;
  if (!handler) {
    throw new Error("Expected Slack message handler");
  }

  await handler({
    message: {
      channel: "C123",
      user: "U123",
      text: "thanks for the file",
      ts: "1712800000.000100",
      thread_ts: "1712790000.000050",
    },
  });

  expect(onMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "slack",
      chatId: "C123",
      text: "thanks for the file",
      threadId: "1712790000.000050",
      isMention: true,
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

test("inbound debounce: message arrives first, then app_mention for same ts → single dispatch without duplicate mention text", async () => {
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
      text: "<@U0AS42PTEAX> /model",
      ts: "1712800000.000099",
      thread_ts: "1712800000.000099",
    },
  });
  // Same ts fires `app_mention` shortly after.
  await mentionHandler({
    event: {
      channel: "C123",
      user: "U123",
      text: "<@U0AS42PTEAX> /model",
      ts: "1712800000.000099",
      thread_ts: "1712800000.000099",
    },
  });

  // Neither has dispatched yet — both sit inside the debounce window.
  expect(dispatched).toEqual([]);

  await sleep(80);

  // One dispatch; the duplicate message/app_mention events for the same Slack
  // message must not become `/model\n/model`, which would parse the second
  // command as a model handle.
  expect(dispatched).toEqual([{ text: "/model", isMention: true }]);
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

test("slack adapter sendMessage renders a View on web context footnote when identity is provided", async () => {
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
    accountId: "slack-test-account",
    chatId: "C123",
    text: "Reply with a footnote.",
    threadId: "1712790000.000050",
    agentId: "agent-1",
    conversationId: "conv-1",
  });
  await adapter.sendMessage({
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    text: "Reply without identity.",
    threadId: "1712790000.000050",
  });

  const writeClient = FakeSlackWriteClient.instances[0];
  const postCalls = writeClient?.chat.postMessage.mock
    .calls as unknown as Array<
    Array<{
      channel: string;
      text: string;
      blocks?: Array<{
        type: string;
        text?: { type: string; text: string };
        elements?: Array<{ type: string; text: string }>;
      }>;
    }>
  >;
  const withIdentity = postCalls[0]?.[0];
  expect(withIdentity?.text).toBe("Reply with a footnote.");
  const blocks = withIdentity?.blocks ?? [];
  // Body rides a markdown block: section blocks clamp long text with
  // per-block "Show more" accordions; markdown blocks render in full.
  expect(blocks[0]).toMatchObject({
    type: "markdown",
    text: "Reply with a footnote.",
  });
  const footnoteBlock = blocks[blocks.length - 1];
  expect(footnoteBlock?.type).toBe("context");
  expect(footnoteBlock?.elements?.[0]?.text).toBe(
    "<https://chat.letta.com/chat/agent-1?conversation=conv-1|View on web>",
  );
  // Without identity: plain text, no blocks.
  expect(postCalls[1]?.[0]?.blocks).toBeUndefined();
});

async function createStartedSlackAdapter(
  overrides: Partial<SlackChannelAccount> = {},
) {
  const adapter = createSlackAdapter({
    ...slackAccountDefaults,
    channel: "slack",
    enabled: true,
    mode: "socket",
    botToken: "xoxb-test-token-1234567890",
    appToken: "xapp-test-token-1234567890",
    dmPolicy: "pairing",
    allowedUsers: [],
    ...overrides,
  });
  await adapter.start();
  return adapter;
}

function createSlackTurnSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    chatType: "channel",
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712800000.000200",
    threadId: "1712800000.000100",
    agentId: "agent-1",
    conversationId: "conv-1",
    ...overrides,
  };
}

function getSlackWriteClient(): FakeSlackWriteClient {
  const client = FakeSlackWriteClient.instances[0];
  if (!client) {
    throw new Error("Expected Slack write client");
  }
  return client;
}

test("slack status event table: flat mention queues a pinned thinking status", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource({
    messageId: "1712800000.000100",
    threadId: "1712800000.000100",
  });

  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source });

  const client = getSlackWriteClient();
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712800000.000100",
    status: "is thinking...",
    loading_messages: ["is thinking..."],
  });
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack status event table: established turns stay quiet and clear a stale ghost once", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();

  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });

  const client = getSlackWriteClient();
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712800000.000100",
    status: "",
  });
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack status event table: concrete descriptions replace in place and generic updates do nothing", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Inspecting the Slack adapter",
    sources: [source],
  });
  const client = getSlackWriteClient();
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712800000.000100",
    status: "is working...",
    loading_messages: ["Inspecting the Slack adapter"],
  });

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "thinking",
    state: "updated",
    message: "Thinking",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Preparing tool call",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "completed",
    message: "Tool finished",
    toolName: "Bash",
    toolDetails: "Inspecting the Slack adapter",
    sources: [source],
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);

  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Running focused tests",
    sources: [source],
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(2);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({
      loading_messages: ["Running focused tests"],
    }),
  );
});

test("slack status event table: concurrent title swaps are sent in event order", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const sentTitles: string[] = [];
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let releaseFirstWrite: (() => void) | undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  FakeSlackWriteClient.setStatusHandler = async (args) => {
    sentTitles.push((args.loading_messages as string[])[0] ?? "");
    if (sentTitles.length === 1) {
      markFirstStarted?.();
      await firstWriteGate;
    }
    return { ok: true };
  };

  const firstUpdate = adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Reading the adapter",
    sources: [source],
  });
  await firstStarted;
  const secondUpdate = adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Running the tests",
    sources: [source],
  });

  await Promise.resolve();
  expect(sentTitles).toEqual(["Reading the adapter"]);
  releaseFirstWrite?.();
  await Promise.all([firstUpdate, secondUpdate]);
  expect(sentTitles).toEqual(["Reading the adapter", "Running the tests"]);
});

test("slack status event table: queued mid-turn input does not clear live status", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Working through the turn",
    sources: [source],
  });

  const client = getSlackWriteClient();
  await adapter.handleTurnLifecycleEvent?.({
    type: "queued",
    source: { ...source, messageId: "1712800000.000300" },
  });

  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack status event table: flat-channel activity remains status-only", async () => {
  const source = createSlackTurnSource({
    messageId: "1712800000.000100",
    threadId: "1712800000.000100",
  });
  const adapter = await createStartedSlackAdapter();
  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Reading the implementation",
    sources: [source],
  });

  const client = getSlackWriteClient();
  expect(client.chat.postMessage).not.toHaveBeenCalled();
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(2);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "is working...",
      loading_messages: ["Reading the implementation"],
    }),
  );
});

test("slack status event table: reactions keep status active while messages make it non-sticky", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const progress = {
    type: "progress" as const,
    kind: "tool" as const,
    state: "started" as const,
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Waiting on a long command",
    sources: [source],
  };
  await adapter.handleTurnProgressEvent?.(progress);
  const client = getSlackWriteClient();

  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "",
    reaction: "eyes",
    targetMessageId: "1712800000.000200",
    agentId: "agent-1",
    conversationId: "conv-1",
  });
  expect(client.reactions.add).toHaveBeenCalledTimes(1);
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);

  await adapter.sendMessage({
    channel: "slack",
    chatId: "C123",
    text: "A durable reply",
    threadId: "1712800000.000100",
    agentId: "agent-1",
    conversationId: "conv-1",
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);

  await adapter.handleTurnProgressEvent?.(progress);
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(2);
});

test("slack terminal table: end_turn and cancelled clear without posting", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const clientProgress = {
    type: "progress" as const,
    kind: "tool" as const,
    state: "started" as const,
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Doing work",
    sources: [source],
  };

  await adapter.handleTurnProgressEvent?.(clientProgress);
  const client = getSlackWriteClient();
  client.assistant.threads.setStatus.mockClear();
  client.chat.postMessage.mockClear();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
    stopReason: "end_turn",
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.assistant.threads.setStatus).toHaveBeenLastCalledWith({
    channel_id: "C123",
    thread_ts: "1712800000.000100",
    status: "",
  });
  expect(client.chat.postMessage).not.toHaveBeenCalled();

  await adapter.handleTurnProgressEvent?.(clientProgress);
  client.assistant.threads.setStatus.mockClear();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-2",
    sources: [source],
    outcome: "cancelled",
    stopReason: "cancelled",
  });
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack terminal table: fatal stops post one quiet error with a web footnote", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Doing work",
    sources: [source],
  });
  const client = getSlackWriteClient();
  client.assistant.threads.setStatus.mockClear();
  client.chat.postMessage.mockClear();

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "error",
    stopReason: "llm_api_error",
    error: "Provider request failed.",
    runId: "run-1",
  });

  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(1);
  expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  const postCalls = client.chat.postMessage.mock.calls as unknown as Array<
    Array<{
      text: string;
      blocks?: Array<{
        type: string;
        text?: string;
        elements?: Array<{ text: string }>;
      }>;
    }>
  >;
  const call = postCalls[0]?.[0] as {
    text: string;
    blocks?: Array<{
      type: string;
      text?: string;
      elements?: Array<{ text: string }>;
    }>;
  };
  expect(call.text).toBe("Provider request failed.");
  expect(call.text).not.toContain("Turn failed");
  expect(call.text).not.toContain("```");
  expect(call.blocks?.[0]).toEqual({
    type: "markdown",
    text: "Provider request failed.",
  });
  expect(call.blocks?.at(-1)?.elements?.[0]?.text).toBe(
    "<https://chat.letta.com/chat/agent-1?conversation=conv-1|View on web>",
  );
});

test("slack terminal table: tool_rule is quiet, no_tool_call is fatal, and approval is non-terminal", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();

  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
    stopReason: "tool_rule",
  });
  const client = getSlackWriteClient();
  expect(client.chat.postMessage).not.toHaveBeenCalled();

  client.assistant.threads.setStatus.mockClear();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-2",
    sources: [source],
    outcome: "error",
    stopReason: "no_tool_call",
  });
  expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
  const postCalls = client.chat.postMessage.mock.calls as unknown as Array<
    Array<{ text: string }>
  >;
  expect(postCalls[0]?.[0]?.text).toBe(
    "Something went wrong while processing that message. Please try again.",
  );

  client.assistant.threads.setStatus.mockClear();
  client.chat.postMessage.mockClear();
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-3",
    sources: [source],
    outcome: "error",
    stopReason: "requires_approval",
  });
  expect(client.assistant.threads.setStatus).not.toHaveBeenCalled();
  expect(client.chat.postMessage).not.toHaveBeenCalled();
});

test("slack approval widget forwards the click and replaces its buttons with the decision", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const onControlResponse = mock(async (): Promise<"handled"> => "handled");
  adapter.onControlResponse = onControlResponse;

  await adapter.handleControlRequestEvent?.({
    requestId: "request-1",
    kind: "generic_tool_approval",
    source,
    toolName: "Bash",
    input: { command: "bun test" },
  });

  const client = getSlackWriteClient();
  const postCalls = client.chat.postMessage.mock.calls as unknown as Array<
    Array<{
      blocks?: Array<{
        type: string;
        elements?: Array<{ value?: string; text?: { text: string } }>;
      }>;
    }>
  >;
  const actions = postCalls[0]?.[0]?.blocks?.find(
    (block) => block.type === "actions",
  );
  expect(actions?.elements?.map((element) => element.text?.text)).toEqual([
    "Approve",
    "Deny",
  ]);
  const approveValue = actions?.elements?.[0]?.value;
  expect(approveValue).toBeString();

  const app = FakeSlackApp.instances[0];
  const handler = app?.actionHandlers.get("letta_channel_approval");
  const ack = mock(async () => {});
  await handler?.({
    body: { user: { id: "U123", name: "Sarah" } },
    action: { value: approveValue },
    ack,
  });

  expect(ack).toHaveBeenCalledTimes(1);
  expect(onControlResponse).toHaveBeenCalledWith({
    requestId: "request-1",
    senderId: "U123",
    channel: "slack",
    accountId: "slack-test-account",
    chatId: "C123",
    threadId: "1712800000.000100",
    response: {
      request_id: "request-1",
      decision: { behavior: "allow" },
    },
  });
  expect(client.chat.update).toHaveBeenCalledTimes(1);
  expect(client.chat.update).toHaveBeenLastCalledWith({
    channel: "C123",
    ts: "1712800000.000100",
    text: "Approved by <@U123>.",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Approved by <@U123>." },
      },
    ],
  });
});

test("slack approval widget retires both stale and re-posted recovery prompts", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  const onControlResponse = mock(async (): Promise<"handled"> => "handled");
  adapter.onControlResponse = onControlResponse;
  const event = {
    requestId: "request-recovered",
    kind: "generic_tool_approval" as const,
    source,
    toolName: "Bash",
    input: { command: "bun test" },
  };

  await adapter.handleControlRequestEvent?.(event);
  const client = getSlackWriteClient();
  client.chat.postMessage.mockResolvedValueOnce({
    ts: "1712800000.000400",
  });
  await adapter.handleControlRequestEvent?.(event);

  const postCalls = client.chat.postMessage.mock.calls as unknown as Array<
    Array<{
      blocks?: Array<{
        type: string;
        elements?: Array<{ value?: string }>;
      }>;
    }>
  >;
  const approveValue = postCalls[0]?.[0]?.blocks?.find(
    (block) => block.type === "actions",
  )?.elements?.[0]?.value;
  const handler = FakeSlackApp.instances[0]?.actionHandlers.get(
    "letta_channel_approval",
  );

  await handler?.({
    body: {
      user: { id: "U123", name: "Sarah" },
      channel: { id: "C123" },
      message: {
        ts: "1712800000.000100",
        thread_ts: "1712800000.000100",
      },
    },
    action: { value: approveValue },
    ack: async () => {},
  });

  expect(onControlResponse).toHaveBeenCalledTimes(1);
  expect(client.chat.update).toHaveBeenCalledTimes(2);
  for (const ts of ["1712800000.000100", "1712800000.000400"]) {
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts,
        text: "Approved by <@U123>.",
      }),
    );
  }
});

test("slack progress never calls a stream API and ignores MessageChannel progress", async () => {
  const adapter = await createStartedSlackAdapter();
  const source = createSlackTurnSource();
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Preparing tool: MessageChannel",
    toolName: "MessageChannel",
    toolDetails: "Sending a reply",
    sources: [source],
  });
  await adapter.handleTurnProgressEvent?.({
    type: "progress",
    kind: "tool",
    state: "started",
    message: "Running tool",
    toolName: "Bash",
    toolDetails: "Checking the implementation",
    sources: [source],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
    stopReason: "end_turn",
  });

  const client = getSlackWriteClient();
  expect(client.assistant.threads.setStatus).toHaveBeenCalledTimes(2);
  expect(client.chat.startStream).not.toHaveBeenCalled();
  expect(client.chat.appendStream).not.toHaveBeenCalled();
  expect(client.chat.stopStream).not.toHaveBeenCalled();
});
