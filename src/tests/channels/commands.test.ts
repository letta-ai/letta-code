import { describe, expect, test } from "bun:test";
import {
  buildChannelHelpMessage,
  buildChannelStatusMessage,
  buildUnsupportedChannelCommandMessage,
  listChannelSlashCommands,
  parseChannelSlashCommand,
} from "../../channels/commands";

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

  test("lists supported direct commands for channel help", () => {
    expect(listChannelSlashCommands()).toContainEqual(
      expect.objectContaining({ name: "help", kind: "direct" }),
    );
    expect(listChannelSlashCommands()).toContainEqual(
      expect.objectContaining({ name: "status", kind: "direct" }),
    );

    const text = buildChannelHelpMessage("telegram");
    expect(text).toContain("Telegram is connected to Letta Code.");
    expect(text).toContain("Supported slash commands here: /help, /status.");
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

  test("builds a useful unsupported-command response", () => {
    const command = parseChannelSlashCommand("/compact now");
    expect(command).not.toBeNull();
    if (!command) {
      throw new Error("Expected /compact to parse as a channel slash command");
    }

    const text = buildUnsupportedChannelCommandMessage("telegram", command);
    expect(text).toContain("Telegram received /compact now");
    expect(text).toContain("not supported in channels yet");
    expect(text).toContain("Supported slash commands here: /help, /status.");
    expect(text).toContain("without a leading slash");
  });
});
