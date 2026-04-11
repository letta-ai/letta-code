import { afterEach, beforeEach, expect, mock, test } from "bun:test";

type SlackMessageHandler = (args: {
  message: {
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    subtype?: string;
    bot_id?: string;
  };
}) => Promise<void>;

type SlackEventHandler = (args: {
  event: {
    channel?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}) => Promise<void>;

class FakeSlackApp {
  static instances: FakeSlackApp[] = [];

  readonly client = {
    auth: {
      test: mock(async () => ({ team: "Test Workspace" })),
    },
    chat: {
      postMessage: mock(async () => ({ ts: "1712800000.000100" })),
    },
  };

  messageHandler: SlackMessageHandler | null = null;
  eventHandlers = new Map<string, SlackEventHandler>();
  errorHandler: ((error: Error) => Promise<void>) | null = null;

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

  async init(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

mock.module("../../channels/slack/runtime", () => ({
  loadSlackBoltModule: async () => ({
    default: FakeSlackApp,
  }),
}));

const { createSlackAdapter } = await import("../../channels/slack/adapter");

beforeEach(() => {
  FakeSlackApp.instances.length = 0;
});

afterEach(() => {
  for (const instance of FakeSlackApp.instances) {
    instance.client.auth.test.mockClear();
    instance.client.chat.postMessage.mockClear();
  }
});

test("slack adapter maps reply_to_message_id to thread_ts", async () => {
  const adapter = createSlackAdapter({
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
    replyToMessageId: "1712800000.000200",
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
      messageId: "1712790000.000050",
      chatType: "channel",
    }),
  );
});

test("slack adapter preserves non-leading user mentions in app mention text", async () => {
  const adapter = createSlackAdapter({
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
