import { describe, expect, test } from "bun:test";
import { __listenSubcommandTestUtils } from "@/cli/subcommands/listen";

const { formatFirstRunWelcome } = __listenSubcommandTestUtils;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_ESCAPE = /\x1b\[/;

describe("first-run welcome banner", () => {
  test("color output draws the logo with escape sequences", () => {
    const lines = formatFirstRunWelcome("my-laptop", true);
    const joined = lines.join("\n");

    expect(joined).toMatch(ANSI_ESCAPE);
    expect(joined).toContain("Welcome to Letta");
    expect(joined).toContain('Registering this computer as "my-laptop"');
    // Logo cells are 24-bit background colors.
    expect(joined).toContain("\x1b[48;2;");
  });

  test("plain output contains no escape sequences and drops the logo", () => {
    const lines = formatFirstRunWelcome("my-laptop", false);
    const joined = lines.join("\n");

    expect(joined).not.toMatch(ANSI_ESCAPE);
    expect(lines).toEqual([
      "",
      "Welcome to Letta",
      'Registering this computer as "my-laptop" so your agent can work here. Use --computer-name to change it.',
      "",
    ]);
  });
});
