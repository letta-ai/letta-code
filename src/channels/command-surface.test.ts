import { describe, expect, test } from "bun:test";
import {
  buildChannelHelpMessage,
  buildUnsupportedChannelCommandMessage,
  type ChannelSlashCommandDefinition,
  type ChannelSlashCommandSurfaceOptions,
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

const CLOUD_EXTRA_COMMANDS: ChannelSlashCommandDefinition[] = [
  { name: "agent", kind: "direct", summary: "Show the connected agent." },
  {
    name: "config",
    kind: "direct",
    summary: "Get the Slack connection settings link.",
  },
  {
    name: "convo",
    kind: "direct",
    summary: "Get the link to this conversation in Letta.",
  },
];

const CLOUD_SURFACE_OPTIONS: ChannelSlashCommandSurfaceOptions = {
  extraCommands: CLOUD_EXTRA_COMMANDS,
  extraCommandsLabel: "Cloud-only commands",
};

describe("host-extra command definitions", () => {
  test("listChannelSlashCommands appends extras after the shared surface", () => {
    const names = listChannelSlashCommands(CLOUD_SURFACE_OPTIONS).map(
      (command) => command.name,
    );
    expect(names).toEqual([
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
      "agent",
      "config",
      "convo",
    ]);
  });

  test("shared names win on collision; colliding extras and aliases are dropped", () => {
    const merged = listChannelSlashCommands({
      extraCommands: [
        // Collides with a shared command name (case-insensitively).
        { name: "Model", kind: "direct", summary: "host model override" },
        // Collides with a shared alias.
        { name: "reflect", kind: "direct", summary: "host reflect override" },
        // Collides with a Slack mention-only shared command.
        { name: "new", kind: "direct", summary: "host new override" },
        // Survives, but its colliding alias is filtered.
        {
          name: "agent",
          aliases: ["status", "who"],
          kind: "direct",
          summary: "Show the connected agent.",
        },
        // Collides with the earlier surviving extra.
        { name: "agent", kind: "direct", summary: "duplicate extra" },
        // Collides with the earlier surviving extra's alias.
        { name: "who", kind: "direct", summary: "alias collision" },
      ],
    });
    const extras = merged.slice(11);
    expect(extras).toEqual([
      {
        name: "agent",
        aliases: ["who"],
        kind: "direct",
        summary: "Show the connected agent.",
      },
    ]);
    expect(
      merged.find((command) => command.name === "model")?.summary,
    ).toContain("switch the model");
  });

  test("parseChannelSlashCommand parses extras without any registration", () => {
    expect(parseChannelSlashCommand("/agent show")).toEqual({
      name: "agent",
      args: "show",
      raw: "/agent show",
    });
    expect(parseChannelSlashCommand("/convo")).toMatchObject({
      name: "convo",
      args: "",
    });
  });

  test("slack help renders extras in a labeled section before the closing lines", () => {
    const message = buildChannelHelpMessage(
      "slack",
      defaultChannelDisplayName,
      CLOUD_SURFACE_OPTIONS,
    );
    const lines = message.split("\n");
    const labelIndex = lines.indexOf("Cloud-only commands:");
    expect(labelIndex).toBeGreaterThan(0);
    expect(lines[labelIndex - 1]).toBe(
      "@agent /reload - reload settings, local mods, and agent secrets",
    );
    expect(lines[labelIndex + 1]).toBe(
      "@agent /agent - Show the connected agent.",
    );
    expect(lines[labelIndex + 2]).toBe(
      "@agent /config - Get the Slack connection settings link.",
    );
    expect(lines[labelIndex + 3]).toBe(
      "@agent /convo - Get the link to this conversation in Letta.",
    );
    expect(lines[labelIndex + 4]).toStartWith("Legacy bang aliases still work");
  });

  test("generic help renders extras as a labeled paragraph after the shared list", () => {
    const message = buildChannelHelpMessage(
      "telegram",
      defaultChannelDisplayName,
      CLOUD_SURFACE_OPTIONS,
    );
    expect(message).toContain(
      "Supported slash commands here: /help, /status, /whoami, /pause, /resume, /cancel, /chat, /feedback, /model, /reflection, /reload.\n\nCloud-only commands here: /agent, /config, /convo.",
    );
  });

  test("help uses the default extras label when none is provided", () => {
    const message = buildChannelHelpMessage(
      "telegram",
      defaultChannelDisplayName,
      { extraCommands: CLOUD_EXTRA_COMMANDS },
    );
    expect(message).toContain("Host commands here: /agent, /config, /convo.");
  });

  test("unknown-command suggestions include extras", () => {
    const command = parseChannelSlashCommand("/bogus");
    expect(command).not.toBeNull();
    if (!command) return;
    expect(
      buildUnsupportedChannelCommandMessage(
        "telegram",
        command,
        defaultChannelDisplayName,
        CLOUD_SURFACE_OPTIONS,
      ),
    ).toContain(
      "Supported slash commands: /help, /status, /whoami, /pause, /resume, /cancel, /chat, /feedback, /model, /reflection, /reload, /agent, /config, /convo.",
    );
    expect(
      buildUnsupportedChannelCommandMessage(
        "slack",
        command,
        defaultChannelDisplayName,
        CLOUD_SURFACE_OPTIONS,
      ),
    ).toContain(
      "@agent /reload, @agent /agent, @agent /config, @agent /convo.",
    );
  });

  test("bang-command suggestions stay on the legacy alias list", () => {
    const command = parseChannelBangCommand("!bogus");
    expect(command).not.toBeNull();
    if (!command) return;
    const message = buildUnsupportedChannelCommandMessage(
      "slack",
      command,
      defaultChannelDisplayName,
      CLOUD_SURFACE_OPTIONS,
    );
    expect(message).toContain(
      "Supported bang commands: !help, !detach, !model, !new, !reload.",
    );
  });

  test("empty or omitted extras keep every rendered string byte-identical", () => {
    for (const options of [undefined, {}, { extraCommands: [] }] as const) {
      expect(
        buildChannelHelpMessage("slack", defaultChannelDisplayName, options),
      ).toBe(buildChannelHelpMessage("slack"));
      expect(
        buildChannelHelpMessage("telegram", defaultChannelDisplayName, options),
      ).toBe(buildChannelHelpMessage("telegram"));
      expect(listChannelSlashCommands(options)).toEqual(
        listChannelSlashCommands(),
      );
      const command = parseChannelSlashCommand("/bogus");
      expect(command).not.toBeNull();
      if (!command) continue;
      expect(
        buildUnsupportedChannelCommandMessage(
          "slack",
          command,
          defaultChannelDisplayName,
          options,
        ),
      ).toBe(buildUnsupportedChannelCommandMessage("slack", command));
    }
  });

  test("returns fresh copies of extras so callers cannot mutate host input", () => {
    const extras: ChannelSlashCommandDefinition[] = [
      {
        name: "agent",
        aliases: ["who"],
        kind: "direct",
        summary: "Show the connected agent.",
      },
    ];
    const merged = listChannelSlashCommands({ extraCommands: extras });
    const extra = merged.at(-1);
    expect(extra).toBeDefined();
    if (!extra) return;
    extra.name = "mutated";
    extra.aliases?.push("mutated-alias");
    expect(extras[0]?.name).toBe("agent");
    expect(extras[0]?.aliases).toEqual(["who"]);
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
