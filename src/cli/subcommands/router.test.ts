import { describe, expect, test } from "bun:test";
import { runSubcommand } from "@/cli/subcommands/router";

describe("subcommand router", () => {
  test("routes version subcommand before TUI startup", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message));
    };

    try {
      const exitCode = await runSubcommand(["version"]);

      expect(exitCode).toBe(0);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/^\d+\.\d+\.\d+ .*\(Letta Code\)$/);
    } finally {
      console.log = originalLog;
    }
  });

  test("routes connect subcommand", async () => {
    const exitCode = await runSubcommand(["connect", "help"]);
    expect(exitCode).toBe(0);
  });
});
