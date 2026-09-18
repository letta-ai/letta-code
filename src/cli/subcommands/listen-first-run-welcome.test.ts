import { describe, expect, test } from "bun:test";
import { Chalk } from "chalk";
import { __listenSubcommandTestUtils } from "@/cli/subcommands/listen";

const { formatFirstRunWelcome } = __listenSubcommandTestUtils;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_ESCAPE = /\x1b\[/;

describe("first-run welcome banner", () => {
  test("level 0 (redirected stdout, NO_COLOR) emits no escape bytes and drops the logo", () => {
    const lines = formatFirstRunWelcome("my-laptop", new Chalk({ level: 0 }));

    expect(lines.join("\n")).not.toMatch(ANSI_ESCAPE);
    expect(lines).toEqual([
      "",
      "Welcome to Letta",
      'Registering this computer as "my-laptop" so your agent can work here. Use --computer-name to change it.',
      "",
    ]);
  });

  test("level 2 (256-color terminals such as Terminal.app) paints the logo without 24-bit escapes", () => {
    const joined = formatFirstRunWelcome(
      "my-laptop",
      new Chalk({ level: 2 }),
    ).join("\n");

    expect(joined).toContain("\x1b[48;5;");
    expect(joined).not.toContain("\x1b[48;2;");
    expect(joined).toContain("Welcome to Letta");
  });

  test("level 3 paints the logo with 24-bit background cells", () => {
    const joined = formatFirstRunWelcome(
      "my-laptop",
      new Chalk({ level: 3 }),
    ).join("\n");

    expect(joined).toContain("\x1b[48;2;");
  });
});
