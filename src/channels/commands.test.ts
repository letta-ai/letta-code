import { describe, expect, test } from "bun:test";
import {
  buildChannelAlreadyActiveMessage,
  buildChannelAlreadyPausedMessage,
  buildChannelCancelAcceptedMessage,
  buildChannelCancelNoActiveTurnMessage,
  buildChannelCancelUnavailableMessage,
  buildChannelChatLinkMessage,
  buildChannelChatUnavailableMessage,
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
} from "@/channels/commands";

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
      "In Slack threads, mention the app with bang commands: !help, !detach, !model, !new, !reload.",
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
        "https://app.letta.com/chat/agent-1?conversation=conv-1",
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
      "• Claude Sonnet 4.6 — anthropic/claude-sonnet-4-6 (/model sonnet)",
    );
    expect(text).toContain("Available models:");
    expect(text).toContain("• GPT-5 — openai/gpt-5 (/model gpt)");
    expect(text).toContain("…and 1 more.");
    expect(text).not.toContain("missing/model");
    expect(text).toContain("Use /model <handle-or-id>");
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
      "Supported slash commands here: /help, /status, /pause, /resume, /cancel, /chat, /model, /reflection.",
    );
    expect(text).toContain("without a leading slash");

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
      "Supported bang commands here: !help, !detach, !model, !new, !reload.",
    );
  });
});
