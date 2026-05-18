import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildChannelHelpMessage,
  buildChannelPauseResumeMessage,
  buildUnsupportedChannelCommandMessage,
  listChannelSlashCommands,
  parseChannelSlashCommand,
} from "../../channels/commands";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
  getRouteRaw,
} from "../../channels/routing";

beforeEach(() => {
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
});

afterEach(() => {
  clearAllRoutes();
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
});

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
      expect.objectContaining({ name: "pause", kind: "direct" }),
    );
    expect(listChannelSlashCommands()).toContainEqual(
      expect.objectContaining({ name: "resume", kind: "direct" }),
    );

    const text = buildChannelHelpMessage("telegram");
    expect(text).toContain("Telegram is connected to Letta Code.");
    expect(text).toContain(
      "Supported slash commands here: /help, /pause, /resume.",
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
      "Supported slash commands here: /help, /pause, /resume.",
    );
    expect(text).toContain("without a leading slash");
  });

  test("pauses and resumes an existing channel route", () => {
    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "chat-1",
      chatType: "direct",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
    });

    const message = {
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "chat-1",
      senderId: "user-1",
      text: "/pause",
      timestamp: Date.now(),
      chatType: "direct" as const,
    };

    const pauseText = buildChannelPauseResumeMessage("pause", message);
    expect(pauseText).toContain("Telegram paused agent routing");
    expect(getRoute("telegram", "chat-1", "acct-telegram")).toBeNull();
    expect(getRouteRaw("telegram", "chat-1", "acct-telegram")?.enabled).toBe(
      false,
    );

    const resumeText = buildChannelPauseResumeMessage("resume", message);
    expect(resumeText).toContain("Telegram resumed agent routing");
    expect(
      getRoute("telegram", "chat-1", "acct-telegram")?.conversationId,
    ).toBe("conv-1");
  });

  test("pause reports when the chat has no existing route", () => {
    const text = buildChannelPauseResumeMessage("pause", {
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "chat-404",
      senderId: "user-1",
      text: "/pause",
      timestamp: Date.now(),
      chatType: "direct",
    });

    expect(text).toContain("could not find an existing route");
  });
});
