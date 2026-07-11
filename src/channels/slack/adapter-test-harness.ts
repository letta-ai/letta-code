import { afterEach, beforeEach, mock } from "bun:test";
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
    item?: { type?: string; channel?: string; ts?: string };
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

export class FakeSlackApp {
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
      threads: { setStatus: mock(async () => ({ ok: true })) },
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

export class FakeSlackWriteClient {
  static instances: FakeSlackWriteClient[] = [];
  static setStatusHandler:
    | ((args: Record<string, unknown>) => Promise<{ ok: boolean }>)
    | null = null;
  static disableStartStream = false;
  static distinctStreamTs = false;

  readonly token: string;
  readonly options: Record<string, unknown> | undefined;
  readonly streamModesByTs = new Map<string, "chunks" | "markdown_text">();
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
          Array.isArray(args?.chunks) && args.chunks.length
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
        if (
          typeof args?.markdown_text === "string" &&
          Array.isArray(args?.chunks) &&
          args.chunks.length
        ) {
          return {
            ok: false,
            error: "cannot_provide_both_markdown_text_and_chunks",
          };
        }
        if (
          typeof args?.markdown_text === "string" &&
          args.ts &&
          this.streamModesByTs.get(args.ts) === "chunks"
        ) {
          return { ok: false, error: "streaming_mode_mismatch" };
        }
        return { ok: true, ts: "1712800000.000300" };
      },
    ),
  };
  readonly assistant = {
    threads: {
      setStatus: mock(async (args: Record<string, unknown>) => {
        return FakeSlackWriteClient.setStatusHandler
          ? FakeSlackWriteClient.setStatusHandler(args)
          : { ok: true };
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

export const resolveSlackInboundAttachmentsMock = mock(
  async (): Promise<ChannelMessageAttachment[]> => [],
);
export const resolveSlackThreadStarterMock = mock(
  async (): Promise<{
    text: string;
    userId?: string;
    botId?: string;
    ts?: string;
    attachments?: ChannelMessageAttachment[];
  } | null> => null,
);
export const resolveSlackThreadHistoryMock = mock(
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
export const resolveSlackChannelHistoryMock = mock(
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
export const resolveSlackCurrentMessageAttachmentsMock = mock(
  async (): Promise<ChannelMessageAttachment[]> => [],
);

mock.module("./runtime", () => ({
  ensureSlackRuntimeInstalled: async () => false,
  installSlackRuntime: async () => {},
  isSlackRuntimeInstalled: () => true,
  loadSlackBoltModule: async () => ({
    App: FakeSlackApp,
    default: { App: FakeSlackApp },
  }),
  loadSlackWebApiModule: async () => ({
    WebClient: FakeSlackWriteClient,
    default: { WebClient: FakeSlackWriteClient },
  }),
}));

mock.module("./media", () => ({
  readSlackAttachmentFile: async () => Buffer.alloc(0),
  resolveSlackChannelHistory: resolveSlackChannelHistoryMock,
  resolveSlackCurrentMessageAttachments:
    resolveSlackCurrentMessageAttachmentsMock,
  resolveSlackInboundAttachments: resolveSlackInboundAttachmentsMock,
  resolveSlackThreadStarter: resolveSlackThreadStarterMock,
  resolveSlackThreadHistory: resolveSlackThreadHistoryMock,
}));

const adapterModule = await import("@/channels/slack/adapter");
const accountDisplayModule = await import("@/channels/slack/account-display");
export const createSlackAdapter = adapterModule.createSlackAdapter;
export const resolveSlackAccountDisplayName =
  accountDisplayModule.resolveSlackAccountDisplayName;

export const slackAccountDefaults = {
  accountId: "slack-test-account",
  displayName: "Test Workspace",
  agentId: null,
  defaultPermissionMode: "standard",
  createdAt: "2026-04-11T00:00:00.000Z",
  updatedAt: "2026-04-11T00:00:00.000Z",
} as const;

const originalFetch = globalThis.fetch;
export const fetchMock = mock(
  async () => new Response("uploaded", { status: 200 }),
);

export function installSlackAdapterTestHooks(): void {
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
    resolveSlackCurrentMessageAttachmentsMock.mockReset();
    resolveSlackCurrentMessageAttachmentsMock.mockImplementation(
      async () => [],
    );
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
}

export async function createStartedSlackAdapter(
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

export function createSlackTurnSource(
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

export function getSlackWriteClient(): FakeSlackWriteClient {
  const client = FakeSlackWriteClient.instances[0];
  if (!client) throw new Error("Expected Slack write client");
  return client;
}
