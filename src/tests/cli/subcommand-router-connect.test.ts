import { describe, expect, test } from "bun:test";
import { runSubcommand } from "../../cli/subcommands/router";

describe("subcommand router", () => {
  test("routes connect subcommand", async () => {
    const exitCode = await runSubcommand(["connect", "help"]);
    expect(exitCode).toBe(0);
  });
});
