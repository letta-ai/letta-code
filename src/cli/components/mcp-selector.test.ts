import { describe, expect, test } from "bun:test";
import { withTimeout } from "./McpSelector";

describe("withTimeout", () => {
  test("resolves when the wrapped promise settles before the timeout", async () => {
    await expect(
      withTimeout(Promise.resolve("servers"), 50, "timed out"),
    ).resolves.toBe("servers");
  });

  test("rejects with the supplied message when the wrapped promise hangs", async () => {
    await expect(
      withTimeout(new Promise(() => {}), 1, "MCP list timed out"),
    ).rejects.toThrow("MCP list timed out");
  });
});
