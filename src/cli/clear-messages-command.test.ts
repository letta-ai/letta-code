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

  test("is handled by interactive and remote command paths", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./app/use-submit-handler.ts", import.meta.url),
    );
    const listenerCommandsPath = fileURLToPath(
      new URL("../websocket/listener/commands.ts", import.meta.url),
    );

    expect(readFileSync(submitHandlerPath, "utf8")).toContain(
      'trimmed === "/clear-messages"',
    );
    expect(readFileSync(listenerCommandsPath, "utf8")).toContain(
      'case "clear-messages":',
    );
    expect(SUPPORTED_REMOTE_COMMANDS).toContain("clear-messages");
  });
});
