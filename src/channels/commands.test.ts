import { describe, expect, test } from "bun:test";
import {
  buildChannelAlreadyActiveMessage,
  buildChannelAlreadyPausedMessage,
  buildChannelCancelAcceptedMessage,
  buildChannelCancelNoActiveTurnMessage,
  buildChannelCancelUnavailableMessage,
  buildChannelChatLinkMessage,
  buildChannelChatUnavailableMessage,
  buildChannelCurrentModelMessage,
  buildChannelDetachedMessage,
  buildChannelHelpMessage,
  buildChannelModelListMessage,
  buildChannelModelListUnavailableMessage,
  buildChannelModelUnavailableMessage,
  buildChannelModelUpdatedMessage,
  buildChannelModelUpdateFailedMessage,
  buildChannelNewConversationMessage,
  buildChannelNoRouteMessage,
  buildChannelPausedMessage,
  buildChannelResumedMessage,
  buildChannelStatusMessage,
  buildUnsupportedChannelCommandMessage,
  listChannelSlashCommands,
  parseChannelBangCommand,
  parseChannelSlashCommand,
  tryHandleChannelSlashCommand,
} from "@/channels/commands";
import {
  __testOverrideSubmitChannelFeedback,
  buildChannelFeedbackFailedMessage,
  buildChannelFeedbackNoRouteMessage,
  buildChannelFeedbackSubmittedMessage,
  buildChannelFeedbackTooLongMessage,
  buildChannelFeedbackUsageMessage,
  CHANNEL_FEEDBACK_MESSAGE_MAX,
} from "@/channels/feedback";
import { buildSlackModelPickerBlocks } from "@/channels/slack/model-picker-blocks";
import type {
  ChannelAdapter,
  ChannelRoute,
  InboundChannelMessage,
} from "@/channels/types";

type CapturedDirectReply = {
  chatId: string;
  text: string;
  options?: Parameters<ChannelAdapter["sendDirectReply"]>[2];
};

function createReplyCapturingAdapter(
  replies: CapturedDirectReply[],
  channelId = "telegram",
): ChannelAdapter {
  return {
    id: channelId,
    channelId,
    name: channelId,
    async start() {},
    async stop() {},
    isRunning: () => true,
    async sendMessage() {
      return { messageId: "sent-1" };
    },
    async sendDirectReply(chatId, text, options) {
      replies.push({ chatId, text, ...(options ? { options } : {}) });
    },
  };
}

function makeRoute(params: {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string | null;
}): ChannelRoute {
  return {
    accountId: params.accountId,
    chatId: params.chatId,
    chatType: params.threadId ? "channel" : "direct",
    threadId: params.threadId ?? null,
    agentId: `agent-${params.channel}`,
    conversationId: `conv-${params.channel}`,
    enabled: true,
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
  };
}

describe("channel slash commands", () => {
  test("parses channel slash commands with bot suffixes and args", () => {
    expect(parseChannelSlashCommand(" /HELP@LettaBot extra words ")).toEqual({
      name: "help",
      args: "extra words",
      raw: "/HELP@LettaBot extra words",
    });
  });

  test("ignores normal text and slash-like paths", () => {
    expect(parseChannelSlashCommand("hello /help")).toBeNull();
    expect(parseChannelSlashCommand("/tmp/file.txt")).toBeNull();
  });

  test("parses bang commands for mention-scoped Slack dispatch", () => {
    expect(parseChannelBangCommand(" !MODEL sonnet ")).toEqual({
      name: "model",
      args: "sonnet",
      raw: "!MODEL sonnet",
    });
    expect(parseChannelBangCommand("hello !help")).toBeNull();
  });

  test("collapses stacked duplicate channel commands before parsing args", () => {
    expect(parseChannelSlashCommand("/model\n/model")).toEqual({
      name: "model",
      args: "",
      raw: "/model",
    });
    expect(parseChannelSlashCommand("/model list\n/model list")).toEqual({
      name: "model",
      args: "list",
      raw: "/model list",
    });
    expect(parseChannelBangCommand("!model\n!model")).toEqual({
      name: "model",
      args: "",
      raw: "!model",
    });
  });

  test("keeps non-command continuation lines as channel command args", () => {
    expect(parseChannelSlashCommand("/model\nletta/auto")).toEqual({
      name: "model",
      args: "letta/auto",
      raw: "/model",
    });
  });

  test("handles Slack mention slash commands as control commands", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      options?: { replyToMessageId?: string; threadId?: string | null };
    }> = [];
    const adapter: ChannelAdapter = {
      id: "slack",
      name: "Slack",
      async start() {},
      async stop() {},
      isRunning: () => true,
      async sendMessage() {
        return { messageId: "sent-1" };
      },
      async sendDirectReply(chatId, text, options) {
        replies.push({ chatId, text, ...(options ? { options } : {}) });
      },
    };
    const msg: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "U123",
      text: "/detach",
      timestamp: Date.now(),
      messageId: "1783379000.000100",
      threadId: "1783378000.000100",
      isMention: true,
    };

    await expect(
      tryHandleChannelSlashCommand(adapter, msg, {
        handlers: {
          detach: async (command) => ({
            handled: true,
            text: `detached via ${command.raw}`,
          }),
        },
      }),
    ).resolves.toBe(true);

    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "detached via /detach",
        options: {
          replyToMessageId: "1783379000.000100",
          threadId: "1783378000.000100",
        },
      },
    ]);
  });

  test("lists supported commands for channel help", () => {
    for (const name of [
      "help",
      "status",
      "pause",
      "resume",
      "cancel",
      "chat",
      "feedback",
      "model",
      "reflection",
    ]) {
      expect(listChannelSlashCommands()).toContainEqual(
        expect.objectContaining({ name }),
      );
    }

    const text = buildChannelHelpMessage("telegram");
    expect(text).toContain("Telegram is connected to Letta Code.");
    expect(text).not.toContain("MessageChannel");
    expect(text).toContain(
      "Supported slash commands here: /help, /status, /whoami, /pause, /resume, /cancel, /chat, /feedback, /model, /reflection.",
    );

    const slackText = buildChannelHelpMessage("slack");
    expect(slackText).not.toContain("MessageChannel");
    expect(slackText).toContain(
      "Talk by mentioning the app in a channel thread.",
    );
    expect(slackText).toContain(
      "Control commands start immediately after the mention:",
    );
    expect(slackText).toContain(
      "@agent /model - show this thread's current model",
    );
    expect(slackText).toContain("@agent /model list - show available models");
    expect(slackText).toContain(
      "@agent /model <handle-or-id> - switch this thread's model",
    );
    expect(slackText).toContain("@agent /feedback <message>");
    expect(slackText).toContain("@agent /detach");
    expect(slackText).toContain("@agent /reload");
    expect(slackText).toContain(
      "Legacy bang aliases still work after a mention: !help, !detach, !model, !new, !reload.",
    );
  });

  test("builds channel status for connected and unconnected chats", () => {
    const msg = {
      channel: "telegram",
      chatId: "chat-1",
      senderId: "user-1",
      text: "/status",
      timestamp: Date.now(),
    };

    expect(
      buildChannelStatusMessage(msg, {
        adapterRunning: true,
        accountConfigured: true,
        accountEnabled: true,
        route: {
          chatId: "chat-1",
          agentId: "agent-1",
          conversationId: "conv-1",
          enabled: true,
          createdAt: "2026-05-15T00:00:00.000Z",
        },
      }),
    ).toContain("Route: Connected to a Letta agent conversation.");

    const unconnectedText = buildChannelStatusMessage(msg, {
      adapterRunning: false,
      accountConfigured: false,
      route: null,
    });
    expect(unconnectedText).toContain(
      "No channel account is configured for this receiver.",
    );
    expect(unconnectedText).toContain("Listener: stopped.");
    expect(unconnectedText).toContain("No route is connected");
  });

  test("builds pause and resume route messages", () => {
    const route = {
      accountId: "acct-telegram",
      chatId: "chat-1",
      chatType: "direct" as const,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
    };

    expect(buildChannelNoRouteMessage("telegram")).toContain(
      "could not find an existing route",
    );
    expect(buildChannelPausedMessage("telegram", route)).toContain(
      "Telegram paused agent routing",
    );
    expect(buildChannelAlreadyPausedMessage("telegram")).toContain(
      "already paused",
    );
    expect(buildChannelResumedMessage("telegram", route)).toContain(
      "Telegram resumed agent routing",
    );
    expect(buildChannelAlreadyActiveMessage("telegram")).toContain(
      "already active",
    );
  });

  test("builds feedback command messages", () => {
    expect(buildChannelFeedbackUsageMessage("telegram")).toContain(
      "Usage: /feedback <message>",
    );
    expect(buildChannelFeedbackUsageMessage("slack")).toContain(
      "Usage: /feedback <message>",
    );
    expect(buildChannelFeedbackTooLongMessage("discord")).toContain(
      "Maximum is 10,000 characters",
    );
    expect(buildChannelFeedbackNoRouteMessage("custom")).toContain(
      "connected to a Letta agent conversation",
    );
    expect(buildChannelFeedbackSubmittedMessage("signal")).toContain(
      "feedback submitted",
    );
    expect(buildChannelFeedbackFailedMessage("whatsapp")).toContain(
      "could not submit feedback right now",
    );
  });

  test("submits feedback through the shared route for first-party and custom channels", async () => {
    const cases: Array<{
      channel: string;
      text: string;
      expectedMessage: string;
      isMention?: boolean;
      threadId?: string | null;
    }> = [
      {
        channel: "slack",
        text: "/feedback Slack feedback",
        expectedMessage: "Slack feedback",
        isMention: true,
        threadId: "thread-secret-slack",
      },
      {
        channel: "telegram",
        text: "/feedback Telegram feedback\nwith detail",
        expectedMessage: "Telegram feedback\nwith detail",
      },
      {
        channel: "discord",
        text: "/feedback Discord feedback",
        expectedMessage: "Discord feedback",
      },
      {
        channel: "whatsapp",
        text: "/feedback WhatsApp feedback",
        expectedMessage: "WhatsApp feedback",
      },
      {
        channel: "signal",
        text: "/feedback Signal feedback",
        expectedMessage: "Signal feedback",
      },
      {
        channel: "custom",
        text: "/feedback Custom feedback",
        expectedMessage: "Custom feedback",
      },
      {
        channel: "acme-support",
        text: "/feedback Dynamic plugin feedback",
        expectedMessage: "Dynamic plugin feedback",
      },
    ];
    const payloads: Record<string, unknown>[] = [];
    __testOverrideSubmitChannelFeedback(async (payload) => {
      payloads.push(payload);
    });

    try {
      for (const entry of cases) {
        const replies: CapturedDirectReply[] = [];
        const adapter = createReplyCapturingAdapter(replies, entry.channel);
        const accountId = `acct-${entry.channel}`;
        const chatId = `chat-secret-${entry.channel}`;
        const route = makeRoute({
          channel: entry.channel,
          accountId,
          chatId,
          threadId: entry.threadId ?? null,
        });
        const msg: InboundChannelMessage = {
          channel: entry.channel,
          accountId,
          chatId,
          senderId: `sender-secret-${entry.channel}`,
          senderName: "sender-name-secret",
          text: entry.text,
          timestamp: Date.now(),
          messageId: `message-secret-${entry.channel}`,
          threadId: entry.threadId ?? null,
          chatType: entry.threadId ? "channel" : "direct",
          ...(entry.isMention !== undefined
            ? { isMention: entry.isMention }
            : {}),
          raw: { token: "raw-secret-token" },
          threadContext: {
            history: [
              { senderId: "history-sender", text: "transcript-secret" },
            ],
          },
        };

        await expect(
          tryHandleChannelSlashCommand(adapter, msg, {
            statusContext: {
              adapterRunning: true,
              accountConfigured: true,
              accountEnabled: true,
              route,
            },
          }),
        ).resolves.toBe(true);

        expect(replies).toHaveLength(1);
        expect(replies[0]?.text).toContain("feedback submitted");
      }
    } finally {
      __testOverrideSubmitChannelFeedback(null);
    }

    expect(payloads).toHaveLength(cases.length);
    for (const [index, payload] of payloads.entries()) {
      const entry = cases[index];
      expect(Object.keys(payload).sort()).toEqual([
        "account_id",
        "agent_id",
        "channel",
        "conversation_id",
        "feature",
        "message",
        "platform",
        "version",
      ]);
      expect(payload).toMatchObject({
        message: entry?.expectedMessage,
        feature: "letta-code-channel-feedback",
        channel: entry?.channel,
        account_id: `acct-${entry?.channel}`,
        agent_id: `agent-${entry?.channel}`,
        conversation_id: `conv-${entry?.channel}`,
        platform: process.platform,
      });
    }

    const serializedPayloads = JSON.stringify(payloads);
    expect(serializedPayloads).not.toContain("sender-secret");
    expect(serializedPayloads).not.toContain("sender-name-secret");
    expect(serializedPayloads).not.toContain("chat-secret");
    expect(serializedPayloads).not.toContain("thread-secret");
    expect(serializedPayloads).not.toContain("message-secret");
    expect(serializedPayloads).not.toContain("raw-secret-token");
    expect(serializedPayloads).not.toContain("transcript-secret");
    expect(serializedPayloads).not.toContain("run_id");
    expect(serializedPayloads).not.toContain("settings");
    expect(serializedPayloads).not.toContain("cwd");
  });

  test("validates feedback input and requires a connected route before submission", async () => {
    let submissions = 0;
    __testOverrideSubmitChannelFeedback(async () => {
      submissions += 1;
    });

    try {
      const route = makeRoute({
        channel: "telegram",
        accountId: "acct-telegram",
        chatId: "chat-telegram",
      });
      const validationCases = [
        {
          text: "/feedback   ",
          route,
          expected: "Usage: /feedback <message>",
        },
        {
          text: `/feedback ${"x".repeat(CHANNEL_FEEDBACK_MESSAGE_MAX + 1)}`,
          route,
          expected: "Maximum is 10,000 characters",
        },
        {
          text: "/feedback useful but unpaired",
          route: null,
          expected: "cannot submit /feedback until this chat is connected",
        },
      ];

      for (const validationCase of validationCases) {
        const replies: CapturedDirectReply[] = [];
        const adapter = createReplyCapturingAdapter(replies);
        const msg: InboundChannelMessage = {
          channel: "telegram",
          accountId: "acct-telegram",
          chatId: "chat-telegram",
          senderId: "sender-telegram",
          text: validationCase.text,
          timestamp: Date.now(),
          messageId: "msg-telegram",
        };

        await expect(
          tryHandleChannelSlashCommand(adapter, msg, {
            statusContext: {
              adapterRunning: true,
              accountConfigured: true,
              accountEnabled: true,
              route: validationCase.route,
            },
          }),
        ).resolves.toBe(true);

        expect(replies).toHaveLength(1);
        expect(replies[0]?.text).toContain(validationCase.expected);
      }
    } finally {
      __testOverrideSubmitChannelFeedback(null);
    }

    expect(submissions).toBe(0);
  });

  test("sanitizes feedback submission failures", async () => {
    __testOverrideSubmitChannelFeedback(async () => {
      throw new Error("secret-token raw backend exception");
    });

    try {
      const replies: CapturedDirectReply[] = [];
      const adapter = createReplyCapturingAdapter(replies, "discord");
      const route = makeRoute({
        channel: "discord",
        accountId: "acct-discord",
        chatId: "chat-discord",
      });
      const msg: InboundChannelMessage = {
        channel: "discord",
        accountId: "acct-discord",
        chatId: "chat-discord",
        senderId: "sender-discord",
        text: "/feedback submission should fail",
        timestamp: Date.now(),
        messageId: "msg-discord",
      };

      await expect(
        tryHandleChannelSlashCommand(adapter, msg, {
          statusContext: {
            adapterRunning: true,
            accountConfigured: true,
            accountEnabled: true,
            route,
          },
        }),
      ).resolves.toBe(true);

      expect(replies).toHaveLength(1);
      expect(replies[0]?.text).toBe(
        "Discord could not submit feedback right now. Please try again later.",
      );
      expect(replies[0]?.text).not.toContain("secret-token");
      expect(replies[0]?.text).not.toContain("raw backend exception");
    } finally {
      __testOverrideSubmitChannelFeedback(null);
    }
  });

  test("builds cancel command messages", () => {
    expect(buildChannelCancelAcceptedMessage("slack")).toBe(
      "Slack cancelled the in-progress agent turn for this chat.",
    );
    expect(buildChannelCancelUnavailableMessage("telegram")).toContain(
      "not connected to an active Letta Code conversation yet",
    );
    expect(buildChannelCancelNoActiveTurnMessage("discord")).toContain(
      "no in-progress agent turn",
    );
  });

  test("builds chat command messages", () => {
    const route = {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel" as const,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
    };

    expect(
      buildChannelChatLinkMessage(
        "slack",
        route,
        "https://chat.letta.com/chat/agent-1?conversation=conv-1",
      ),
    ).toContain("Slack chat for this route");
    expect(buildChannelChatUnavailableMessage("telegram", route)).toContain(
      "chat UI is not available",
    );
    expect(buildChannelDetachedMessage("slack")).toContain(
      "detached this thread",
    );
    expect(buildChannelNewConversationMessage("slack", route)).toContain(
      "started a new conversation",
    );
  });

  test("builds current model status command messages", () => {
    expect(
      buildChannelCurrentModelMessage("slack", {
        modelLabel: "GPT-5.5",
        modelHandle: "chatgpt-cameron/gpt-5.5",
        scope: "conversation",
      }),
    ).toBe(
      "Slack current conversation model: GPT-5.5 (chatgpt-cameron/gpt-5.5).\nUse @agent /model list to see available models, or @agent /model <handle-or-id> to switch.",
    );
    expect(
      buildChannelCurrentModelMessage("telegram", {
        modelLabel: "Claude Sonnet 4.6",
        modelHandle: "anthropic/claude-sonnet-4-6",
        scope: "agent",
      }),
    ).toContain("Telegram current agent model");
  });

  test("builds model selector-style command messages", () => {
    const text = buildChannelModelListMessage("slack", {
      entries: [
        {
          id: "sonnet",
          handle: "anthropic/claude-sonnet-4-6",
          label: "Claude Sonnet 4.6",
          description: "",
          isFeatured: true,
        },
        {
          id: "gpt",
          handle: "openai/gpt-5",
          label: "GPT-5",
          description: "",
        },
      ],
      availableHandles: [
        "openai/gpt-5",
        "anthropic/claude-sonnet-4-6",
        "custom/model",
      ],
      recentHandles: ["anthropic/claude-sonnet-4-6", "missing/model"],
      limit: 2,
    });

    expect(text).toContain("Slack model selector");
    expect(text).toContain("Recent models:");
    expect(text).toContain(
      "• Claude Sonnet 4.6 — anthropic/claude-sonnet-4-6 (@agent /model sonnet)",
    );
    expect(text).toContain("Available models:");
    expect(text).toContain("• GPT-5 — openai/gpt-5 (@agent /model gpt)");
    expect(text).toContain("…and 1 more.");
    expect(text).not.toContain("missing/model");
    expect(text).toContain(
      "Mention the app with @agent /model <handle-or-id> to switch this thread's routed model. Use @agent /model to show the current model. Legacy !model still works after a mention.",
    );
  });

  test("builds Slack model picker blocks", () => {
    const blocks = buildSlackModelPickerBlocks({
      current: {
        modelLabel: "GPT-5.5",
        modelHandle: "chatgpt-cameron/gpt-5.5",
        scope: "conversation",
      },
      entries: [
        {
          id: "sonnet",
          handle: "anthropic/claude-sonnet-4-6",
          label: "Claude Sonnet 4.6",
          description: "Balanced coding model",
          isFeatured: true,
        },
        {
          id: "gpt",
          handle: "openai/gpt-5",
          label: "GPT-5",
          description: "",
        },
      ],
      availableHandles: ["openai/gpt-5", "anthropic/claude-sonnet-4-6"],
      recentHandles: ["anthropic/claude-sonnet-4-6"],
    });

    expect(blocks).toBeDefined();
    const currentBlock = blocks?.[0] as Record<string, unknown> | undefined;
    const explanatoryBlock = blocks?.[1] as Record<string, unknown> | undefined;
    const actionsBlock = blocks?.[2] as Record<string, unknown> | undefined;
    const contextBlock = blocks?.[3] as Record<string, unknown> | undefined;
    const elements = actionsBlock?.elements as
      | Array<{
          action_id?: string;
          type?: string;
          options?: Array<{ value?: string }>;
        }>
      | undefined;
    const selectElement = elements?.[0];

    expect(currentBlock?.type).toBe("section");
    expect(JSON.stringify(currentBlock)).toContain(
      "Current conversation model",
    );
    expect(explanatoryBlock).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Choose a model for this routed conversation:",
      },
    });
    expect(explanatoryBlock).not.toHaveProperty("accessory");
    expect(actionsBlock?.type).toBe("actions");
    expect(elements).toHaveLength(1);
    expect(selectElement?.type).toBe("static_select");
    expect(selectElement?.action_id).toBe("letta_channel_model_select");
    expect(selectElement?.options?.map((option) => option.value)).toEqual([
      "sonnet",
      "gpt",
    ]);
    expect(contextBlock?.type).toBe("context");
    expect(JSON.stringify(blocks)).toContain("Claude Sonnet 4.6");
  });

  test("builds model update and unavailable messages", () => {
    const fallback = buildChannelModelListMessage("telegram", {
      entries: [
        {
          id: "auto",
          handle: "letta/auto",
          label: "Auto",
          description: "",
          isDefault: true,
        },
      ],
      availableHandles: null,
    });
    expect(fallback).toContain("Availability lookup failed");
    expect(fallback).toContain("• Auto — letta/auto (/model auto)");
    expect(buildChannelModelListUnavailableMessage("discord", "boom")).toBe(
      "Discord could not load the model list: boom",
    );
    expect(
      buildChannelModelUpdatedMessage("slack", {
        modelLabel: "Claude Sonnet 4.6",
        modelHandle: "anthropic/claude-sonnet-4-6",
        appliedTo: "conversation",
      }),
    ).toBe(
      "Slack updated this conversation's model to Claude Sonnet 4.6 (anthropic/claude-sonnet-4-6).",
    );
    expect(
      buildChannelModelUpdateFailedMessage("telegram", "bad-model", "nope"),
    ).toBe(
      "Telegram could not switch this chat's routed model to bad-model: nope",
    );
    expect(buildChannelModelUnavailableMessage("discord")).toContain(
      "listener is not ready yet",
    );
  });

  test("builds a useful unsupported-command response", () => {
    const command = parseChannelSlashCommand("/compact now");
    expect(command).not.toBeNull();
    if (!command) {
      throw new Error("Expected /compact to parse as a channel slash command");
    }

    const text = buildUnsupportedChannelCommandMessage("telegram", command);
    expect(text).toContain("Telegram received /compact now");
    expect(text).toContain("not supported in channels yet");
    expect(text).toContain(
      "Supported slash commands: /help, /status, /whoami, /pause, /resume, /cancel, /chat, /feedback, /model, /reflection.",
    );
    expect(text).toContain("without a leading slash");

    const slackSlashText = buildUnsupportedChannelCommandMessage(
      "slack",
      command,
    );
    expect(slackSlashText).toContain("Supported Slack mention commands:");
    expect(slackSlashText).toContain("@agent /model <handle-or-id>");
    expect(slackSlashText).toContain("@agent /feedback <message>");

    const bangCommand = parseChannelBangCommand("!pause");
    expect(bangCommand).not.toBeNull();
    if (!bangCommand) {
      throw new Error("Expected !pause to parse as a bang command");
    }
    const bangText = buildUnsupportedChannelCommandMessage(
      "slack",
      bangCommand,
    );
    expect(bangText).toContain("Slack received !pause");
    expect(bangText).toContain(
      "Supported bang commands: !help, !detach, !model, !new, !reload.",
    );
  });
});
