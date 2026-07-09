import { expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSlackAdapter,
  FakeSlackApp,
  installSlackAdapterTestHooks,
  slackAccountDefaults,
} from "./slack-adapter.test-harness";

installSlackAdapterTestHooks();

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
