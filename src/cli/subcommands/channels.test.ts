import { describe, expect, spyOn, test } from "bun:test";
import { runChannelsSubcommand } from "@/cli/subcommands/channels";

describe("channels route add", () => {
  test("rejects a labeled Telegram Chat ID before changing route state", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await runChannelsSubcommand([
        "route",
        "add",
        "--channel",
        "telegram",
        "--chat-id",
        "Chat ID: 7945451305",
        "--agent",
        "agent-telegram",
      ]);

      expect(result).toBe(1);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Paste only the numeric Telegram Chat ID"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
