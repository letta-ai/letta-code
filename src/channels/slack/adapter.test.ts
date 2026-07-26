import { expect, mock, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSlackAdapter,
  downloadSlackAttachmentByIdMock,
  FakeSlackApp,
  FakeSlackWriteClient,
  fetchMock,
  installSlackAdapterTestHooks,
  resolveSlackAccountDisplayName,
  slackAccountDefaults,
} from "./adapter-test-harness";
import { buildSlackModelPickerBlocks } from "./model-picker-blocks";

installSlackAdapterTestHooks();

test("slack adapter downloads attachments through its authenticated app client", async () => {
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

  await adapter.downloadAttachment({
    attachmentId: "FLARGE",
    chatId: "C123",
    threadId: "1712790000.000050",
    messageId: "1712800000.000100",
  });

  expect(downloadSlackAttachmentByIdMock).toHaveBeenCalledWith({
    accountId: "slack-test-account",
    token: "xoxb-test-token-1234567890",
    attachmentId: "FLARGE",
    channelId: "C123",
    threadTs: "1712790000.000050",
    messageTs: "1712800000.000100",
    client: FakeSlackApp.instances[0]?.client,
  });
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
