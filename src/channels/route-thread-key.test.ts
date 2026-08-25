import { describe, expect, test } from "bun:test";
import {
  CHANNEL_ROOT_THREAD_KEY,
  channelRouteThreadIdFromKey,
  resolveChannelRouteThreadKey,
} from "./route-thread-key";

describe("resolveChannelRouteThreadKey", () => {
  test("returns the trimmed thread id when present", () => {
    expect(resolveChannelRouteThreadKey("1712345678.000100")).toBe(
      "1712345678.000100",
    );
    expect(resolveChannelRouteThreadKey("  1712345678.000100  ")).toBe(
      "1712345678.000100",
    );
  });

  test("returns the root sentinel for missing or blank thread ids", () => {
    expect(resolveChannelRouteThreadKey(undefined)).toBe(
      CHANNEL_ROOT_THREAD_KEY,
    );
    expect(resolveChannelRouteThreadKey(null)).toBe(CHANNEL_ROOT_THREAD_KEY);
    expect(resolveChannelRouteThreadKey("")).toBe(CHANNEL_ROOT_THREAD_KEY);
    expect(resolveChannelRouteThreadKey("   ")).toBe(CHANNEL_ROOT_THREAD_KEY);
  });

  test("keys every unthreaded message in one chat identically", () => {
    // The bug this rule prevents: substituting each message's own ts for a
    // missing thread id gives every top-level DM a distinct route key, which
    // creates a new conversation per message.
    const first = resolveChannelRouteThreadKey(null);
    const second = resolveChannelRouteThreadKey(null);
    expect(first).toBe(second);
  });
});

describe("channelRouteThreadIdFromKey", () => {
  test("returns null for the root sentinel", () => {
    expect(channelRouteThreadIdFromKey(CHANNEL_ROOT_THREAD_KEY)).toBeNull();
  });

  test("returns null for missing or blank keys", () => {
    expect(channelRouteThreadIdFromKey(undefined)).toBeNull();
    expect(channelRouteThreadIdFromKey(null)).toBeNull();
    expect(channelRouteThreadIdFromKey("")).toBeNull();
    expect(channelRouteThreadIdFromKey("   ")).toBeNull();
  });

  test("returns the trimmed thread id for real keys", () => {
    expect(channelRouteThreadIdFromKey("1712345678.000100")).toBe(
      "1712345678.000100",
    );
    expect(channelRouteThreadIdFromKey(" 1712345678.000100 ")).toBe(
      "1712345678.000100",
    );
  });

  test("round-trips with resolveChannelRouteThreadKey", () => {
    expect(
      channelRouteThreadIdFromKey(resolveChannelRouteThreadKey(null)),
    ).toBeNull();
    expect(
      channelRouteThreadIdFromKey(
        resolveChannelRouteThreadKey("1712345678.000100"),
      ),
    ).toBe("1712345678.000100");
  });
});
