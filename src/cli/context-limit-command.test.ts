import { describe, expect, test } from "bun:test";
import { commands, executeCommand } from "@/cli/commands/registry";

describe("/context-limit command registration", () => {
  test("advertises the canonical command and hides the legacy alias", () => {
    expect(commands["/context-limit"]).toMatchObject({
      desc: "Set or reset the max context window",
      args: "[tokens] [--override]",
    });
    expect(commands["/context-limit"]?.hidden).not.toBe(true);

    expect(commands["/set-max-context"]).toMatchObject({
      desc: "Alias for /context-limit",
      args: "[tokens] [--override]",
      hidden: true,
    });

    const discoverableCommands = Object.entries(commands)
      .filter(([, command]) => !command.hidden)
      .map(([name]) => name);

    expect(discoverableCommands).toContain("/context-limit");
    expect(discoverableCommands).not.toContain("/set-max-context");
  });

  test("executes canonical and legacy registry entries", async () => {
    await expect(
      executeCommand("/context-limit 10000 --override"),
    ).resolves.toMatchObject({
      success: true,
      output: "Setting max context window...",
    });

    await expect(
      executeCommand("/set-max-context 10000 --override"),
    ).resolves.toMatchObject({
      success: true,
      output: "Setting max context window...",
    });
  });
});
