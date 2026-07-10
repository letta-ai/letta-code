import { expect, mock, test } from "bun:test";
import {
  createSlackAdapter,
  FakeSlackApp,
  installSlackAdapterTestHooks,
  resolveSlackInboundAttachmentsMock,
  slackAccountDefaults,
} from "./adapter-test-harness";

installSlackAdapterTestHooks();

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
