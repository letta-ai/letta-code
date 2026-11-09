import { describe, expect, test } from "bun:test";
import { reflectionLaunchFailureMessage } from "@/websocket/listener/commands";

describe("listener reflection launch failure messages", () => {
  test("a dirty parent memory repository reports an actionable reason", () => {
    const message = reflectionLaunchFailureMessage({
      launched: false,
      reason: "parent_dirty",
    });

    expect(message).toContain("parent memory repository");
    expect(message).not.toContain("Unknown error");
  });

  test("every non-launched reason is mapped to a message", () => {
    const reasons = [
      "memfs_disabled",
      "windows_disabled",
      "cutover",
      "already_active",
      "configuration_error",
      "retry_backoff",
      "parent_dirty",
      "no_payload",
    ] as const;

    for (const reason of reasons) {
      const message = reflectionLaunchFailureMessage({
        launched: false,
        reason,
      });
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("Unknown error");
    }
  });

  test("a launch error still surfaces the underlying error text", () => {
    const message = reflectionLaunchFailureMessage({
      launched: false,
      reason: "error",
      error: new Error("model provider unavailable"),
    });

    expect(message).toContain("model provider unavailable");
  });
});
