import { describe, expect, test } from "bun:test";
import { createAgentThreadTracker } from "./agent-thread-tracker";

describe("createAgentThreadTracker", () => {
  test("remembers and checks channel threads", () => {
    const tracker = createAgentThreadTracker();
    expect(tracker.has("C123", "1234567890.123456")).toBe(false);
    tracker.remember("C123", "1234567890.123456");
    expect(tracker.has("C123", "1234567890.123456")).toBe(true);
    expect(tracker.has("C123", "9999999999.999999")).toBe(false);
  });

  test("keeps identical thread timestamps isolated by channel", () => {
    const tracker = createAgentThreadTracker();
    tracker.remember("C123", "1234567890.123456");
    expect(tracker.has("C123", "1234567890.123456")).toBe(true);
    expect(tracker.has("C999", "1234567890.123456")).toBe(false);
  });

  test("clear removes all tracked threads", () => {
    const tracker = createAgentThreadTracker();
    tracker.remember("C123", "1111111111.111111");
    tracker.remember("C456", "2222222222.222222");
    expect(tracker.has("C123", "1111111111.111111")).toBe(true);
    expect(tracker.has("C456", "2222222222.222222")).toBe(true);
    tracker.clear();
    expect(tracker.has("C123", "1111111111.111111")).toBe(false);
    expect(tracker.has("C456", "2222222222.222222")).toBe(false);
  });

  test("remember refreshes TTL for existing thread", () => {
    let now = 0;
    const tracker = createAgentThreadTracker({
      maxEntries: 10,
      now: () => now,
      ttlMs: 100,
    });
    tracker.remember("C123", "1234567890.123456");
    now = 75;
    tracker.remember("C123", "1234567890.123456");
    now = 125;
    expect(tracker.has("C123", "1234567890.123456")).toBe(true);
    now = 176;
    expect(tracker.has("C123", "1234567890.123456")).toBe(false);
  });
});
