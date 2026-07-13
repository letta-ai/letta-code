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
import { buildSlackModelPickerBlocks } from "@/channels/slack/model-picker-blocks";
import type { ChannelAdapter, InboundChannelMessage } from "@/channels/types";

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
      "Supported slash commands here: /help, /status, /pause, /resume, /cancel, /chat, /model, /reflection.",
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
    const selectBlock = blocks?.[1] as Record<string, unknown> | undefined;
    const accessory = selectBlock?.accessory as
      | { action_id?: string; type?: string; options?: unknown[] }
      | undefined;
    expect(selectBlock?.type).toBe("section");
    expect(accessory?.type).toBe("static_select");
    expect(accessory?.action_id).toBe("letta_channel_model_select");
    expect(accessory?.options).toHaveLength(2);
    expect(JSON.stringify(blocks)).toContain("Current conversation model");
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
      "Supported slash commands: /help, /status, /pause, /resume, /cancel, /chat, /model, /reflection.",
    );
    expect(text).toContain("without a leading slash");

    const slackSlashText = buildUnsupportedChannelCommandMessage(
      "slack",
      command,
    );
    expect(slackSlashText).toContain("Supported Slack mention commands:");
    expect(slackSlashText).toContain("@agent /model <handle-or-id>");

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
