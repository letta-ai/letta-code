import { describe, expect, test } from "bun:test";
import {
  buildChannelHelpMessage,
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

    const text = buildChannelHelpMessage("telegram");
    expect(text).toContain("Telegram is connected to Letta Code.");
    expect(text).toContain("Supported slash commands here: /help.");
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
    expect(text).toContain("Supported slash commands here: /help.");
    expect(text).toContain("without a leading slash");
  });
});
