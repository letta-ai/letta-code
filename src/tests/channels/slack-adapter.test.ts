import { afterEach, beforeEach, expect, mock, test } from "bun:test";
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
    bot_id?: string;
    files?: Array<{ id?: string; name?: string }>;
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

const resolveSlackInboundAttachmentsMock = mock(
  async (): Promise<ChannelMessageAttachment[]> => [],
);

mock.module("../../channels/slack/runtime", () => ({
  loadSlackBoltModule: async () => ({
    default: FakeSlackApp,
  }),
}));

mock.module("../../channels/slack/media", () => ({
  resolveSlackInboundAttachments: resolveSlackInboundAttachmentsMock,
}));

const { createSlackAdapter, resolveSlackAccountDisplayName } = await import(
  "../../channels/slack/adapter"
);

const slackAccountDefaults = {
  accountId: "slack-test-account",
  displayName: "Test Workspace",
  agentId: null,
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
  resolveSlackInboundAttachmentsMock.mockReset();
  resolveSlackInboundAttachmentsMock.mockImplementation(async () => []);
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  for (const instance of FakeSlackApp.instances) {
    instance.client.auth.test.mockClear();
    instance.client.users.info.mockClear();
    instance.client.chat.postMessage.mockClear();
    instance.client.reactions.add.mockClear();
    instance.client.reactions.remove.mockClear();
    instance.client.files.getUploadURLExternal.mockClear();
    instance.client.files.completeUploadExternal.mockClear();
    instance.init.mockClear();
    instance.start.mockClear();
    instance.stop.mockClear();
  }
  globalThis.fetch = originalFetch;
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

  const app = FakeSlackApp.instances[0];
  expect(app).toBeDefined();
  expect(app?.client.chat.postMessage).toHaveBeenCalledWith({
    channel: "C123",
    text: "hello",
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

  const app = FakeSlackApp.instances[0];
  expect(app?.client.reactions.add).toHaveBeenCalledWith({
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

  const app = FakeSlackApp.instances[0];
  expect(app?.client.files.getUploadURLExternal).toHaveBeenCalledWith({
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
  expect(app?.client.files.completeUploadExternal).toHaveBeenCalledWith({
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
