import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { commands, executeCommand } from "@/cli/commands/registry";
import { SUPPORTED_REMOTE_COMMANDS } from "@/websocket/listener/listener-constants";

describe("/clear-messages command", () => {
  test("is executable but hidden from command discovery", async () => {
    expect(commands["/clear-messages"]).toMatchObject({
      desc: "Reset all agent messages (destructive)",
      hidden: true,
      noArgs: true,
    });
    await expect(executeCommand("/clear-messages")).resolves.toEqual({
      success: true,
      output: "Resetting agent messages...",
    });
  });

  test("is handled by the interactive command path only", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./app/use-submit-handler.ts", import.meta.url),
    );

    expect(readFileSync(submitHandlerPath, "utf8")).toContain(
      'trimmed === "/clear-messages"',
    );
  });

  test("is not advertised to remote clients", () => {
    // The remote clear corrupted the listener's durable input ledger and was
    // removed; the TUI command above is a separate path and still works.
    expect(SUPPORTED_REMOTE_COMMANDS).not.toContain("clear-messages");
    expect(SUPPORTED_REMOTE_COMMANDS).not.toContain("clear");
  });
});
