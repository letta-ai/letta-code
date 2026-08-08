import { describe, expect, test } from "bun:test";
import {
  buildChannelHelpMessage,
  buildUnsupportedChannelCommandMessage,
  defaultChannelDisplayName,
  listChannelSlashCommands,
  parseChannelBangCommand,
  parseChannelSlashCommand,
} from "@/channels/command-surface";
import {
  buildChannelHelpMessage as buildChannelHelpMessageLocal,
  buildUnsupportedChannelCommandMessage as buildUnsupportedChannelCommandMessageLocal,
} from "@/channels/commands";

describe("listChannelSlashCommands", () => {
  test("lists the full command surface in order", () => {
    expect(listChannelSlashCommands().map((command) => command.name)).toEqual([
      "help",
      "status",
      "whoami",
      "pause",
      "resume",
      "cancel",
      "chat",
      "feedback",
      "model",
      "reflection",
      "reload",
    ]);
  });

  test("includes aliases and kinds", () => {
    const byName = new Map(
      listChannelSlashCommands().map((command) => [command.name, command]),
    );
    expect(byName.get("reflection")?.aliases).toEqual(["reflect"]);
    expect(byName.get("model")?.kind).toBe("agent-scoped");
    expect(byName.get("help")?.kind).toBe("direct");
    for (const command of byName.values()) {
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });

  test("returns fresh copies so callers cannot mutate the registry", () => {
    const first = listChannelSlashCommands();
    const firstEntry = first[0];
    expect(firstEntry).toBeDefined();
    if (firstEntry) {
      firstEntry.name = "mutated";
    }
    first.find((command) => command.aliases)?.aliases?.push("mutated-alias");
    const second = listChannelSlashCommands();
    expect(second[0]?.name).toBe("help");
    expect(
      second.find((command) => command.name === "reflection")?.aliases,
    ).toEqual(["reflect"]);
  });
});

describe("parseChannelSlashCommand", () => {
  test("parses name, args, and raw text", () => {
    expect(parseChannelSlashCommand("/model list")).toEqual({
      name: "model",
      args: "list",
      raw: "/model list",
    });
  });

  test("lowercases the command name and strips bot suffixes", () => {
    expect(parseChannelSlashCommand("/Help@letta_bot")).toMatchObject({
      name: "help",
      args: "",
    });
  });

  test("returns null for normal messages and bang commands", () => {
    expect(parseChannelSlashCommand("hello there")).toBeNull();
    expect(parseChannelSlashCommand("!help")).toBeNull();
    expect(parseChannelSlashCommand("")).toBeNull();
  });

  test("keeps continuation lines as args", () => {
    expect(
      parseChannelSlashCommand("/feedback first line\nsecond line"),
    ).toEqual({
      name: "feedback",
      args: "first line\nsecond line",
      raw: "/feedback first line",
    });
  });

  test("ignores stacked duplicate command lines", () => {
    expect(parseChannelSlashCommand("/status\n/status")).toEqual({
      name: "status",
      args: "",
      raw: "/status",
    });
  });
});

describe("parseChannelBangCommand", () => {
  test("parses bang commands", () => {
    expect(parseChannelBangCommand("!model sonnet")).toEqual({
      name: "model",
      args: "sonnet",
      raw: "!model sonnet",
    });
  });

  test("returns null for slash commands and plain text", () => {
    expect(parseChannelBangCommand("/model")).toBeNull();
    expect(parseChannelBangCommand("model")).toBeNull();
  });
});

describe("defaultChannelDisplayName", () => {
  test("maps first-party channel ids to display names", () => {
    expect(defaultChannelDisplayName("slack")).toBe("Slack");
    expect(defaultChannelDisplayName("telegram")).toBe("Telegram");
    expect(defaultChannelDisplayName("whatsapp")).toBe("WhatsApp");
  });

  test("falls back to the raw channel id", () => {
    expect(defaultChannelDisplayName("my-custom-channel")).toBe(
      "my-custom-channel",
    );
  });
});

describe("buildChannelHelpMessage", () => {
  test("renders slack mention guidance with the default resolver", () => {
    const message = buildChannelHelpMessage("slack");
    expect(message).toStartWith("Slack is connected to Letta Code.");
    expect(message).toContain("@agent /model <handle-or-id>");
    expect(message).toContain("Legacy bang aliases still work after a mention");
  });

  test("renders the generic slash command list for other channels", () => {
    const message = buildChannelHelpMessage("telegram");
    expect(message).toStartWith("Telegram is connected to Letta Code.");
    expect(message).toContain(
      "Supported slash commands here: /help, /status, /whoami, /pause, /resume, /cancel, /chat, /feedback, /model, /reflection, /reload.",
    );
  });

  test("uses an injected display-name resolver", () => {
    const message = buildChannelHelpMessage(
      "telegram",
      (channelId) => `Cloud ${channelId}`,
    );
    expect(message).toStartWith("Cloud telegram is connected to Letta Code.");
  });

  test("matches the local host rendering for first-party channels", () => {
    expect(buildChannelHelpMessage("slack")).toBe(
      buildChannelHelpMessageLocal("slack"),
    );
    expect(buildChannelHelpMessage("telegram")).toBe(
      buildChannelHelpMessageLocal("telegram"),
    );
  });
});

describe("buildUnsupportedChannelCommandMessage", () => {
  test("lists slash commands for unknown slash commands", () => {
    const command = parseChannelSlashCommand("/bogus now");
    expect(command).not.toBeNull();
    if (!command) return;
    const message = buildUnsupportedChannelCommandMessage("telegram", command);
    expect(message).toContain(
      "Telegram received /bogus now, but that slash command is not supported in channels yet.",
    );
    expect(message).toContain("Supported slash commands: /help,");
  });

  test("lists mention examples for unknown slack slash commands", () => {
    const command = parseChannelSlashCommand("/bogus");
    expect(command).not.toBeNull();
    if (!command) return;
    const message = buildUnsupportedChannelCommandMessage("slack", command);
    expect(message).toContain(
      "Supported Slack mention commands: @agent /help,",
    );
  });

  test("lists bang aliases for unknown bang commands", () => {
    const command = parseChannelBangCommand("!bogus");
    expect(command).not.toBeNull();
    if (!command) return;
    const message = buildUnsupportedChannelCommandMessage("slack", command);
    expect(message).toContain(
      "Supported bang commands: !help, !detach, !model, !new, !reload.",
    );
  });

  test("uses an injected display-name resolver and matches local rendering", () => {
    const command = parseChannelSlashCommand("/bogus");
    expect(command).not.toBeNull();
    if (!command) return;
    expect(
      buildUnsupportedChannelCommandMessage("slack", command, () => "Custom"),
    ).toStartWith("Custom received /bogus,");
    expect(buildUnsupportedChannelCommandMessage("slack", command)).toBe(
      buildUnsupportedChannelCommandMessageLocal("slack", command),
    );
  });
});
