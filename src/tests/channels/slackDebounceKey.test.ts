import { describe, expect, test } from "bun:test";
import {
  buildSlackDebounceKey,
  buildTopLevelSlackConversationKey,
  resolveSlackInboundDebounceMs,
} from "../../channels/slack/adapter";

const ACCOUNT = "acct-1";

describe("buildSlackDebounceKey", () => {
  test("DMs are channel-scoped (two messages from same user in same DM share a key)", () => {
    const k1 = buildSlackDebounceKey(
      { channel: "D123", ts: "1700000000.000001", user: "U1" },
      ACCOUNT,
    );
    const k2 = buildSlackDebounceKey(
      { channel: "D123", ts: "1700000000.000002", user: "U1" },
      ACCOUNT,
    );
    expect(k1).not.toBeNull();
    expect(k1).toBe(k2);
  });

  test("DMs from different users produce different keys", () => {
    const k1 = buildSlackDebounceKey(
      { channel: "D123", ts: "1.000001", user: "U1" },
      ACCOUNT,
    );
    const k2 = buildSlackDebounceKey(
      { channel: "D123", ts: "1.000002", user: "U2" },
      ACCOUNT,
    );
    expect(k1).not.toBe(k2);
  });

  test("thread replies are thread-scoped", () => {
    const k1 = buildSlackDebounceKey(
      {
        channel: "C123",
        ts: "1700000000.000001",
        thread_ts: "1699999999.000000",
        user: "U1",
      },
      ACCOUNT,
    );
    const k2 = buildSlackDebounceKey(
      {
        channel: "C123",
        ts: "1700000000.000002",
        thread_ts: "1699999999.000000",
        user: "U1",
      },
      ACCOUNT,
    );
    expect(k1).toBe(k2);
  });

  test("probable thread reply (parent_user_id, no thread_ts) uses maybe-thread key", () => {
    const key = buildSlackDebounceKey(
      {
        channel: "C123",
        ts: "1700000000.000001",
        parent_user_id: "U_parent",
        user: "U1",
      },
      ACCOUNT,
    );
    expect(key).toContain("maybe-thread:1700000000.000001");
  });

  test("top-level channel posts are message-ts-scoped (different posts do not merge)", () => {
    const k1 = buildSlackDebounceKey(
      { channel: "C123", ts: "1700000000.000001", user: "U1" },
      ACCOUNT,
    );
    const k2 = buildSlackDebounceKey(
      { channel: "C123", ts: "1700000000.000002", user: "U1" },
      ACCOUNT,
    );
    expect(k1).not.toBe(k2);
  });

  test("missing user (and no bot_id) → null", () => {
    const key = buildSlackDebounceKey({ channel: "C123", ts: "1.0" }, ACCOUNT);
    expect(key).toBeNull();
  });

  test("bot_id is accepted as sender when user is missing", () => {
    const key = buildSlackDebounceKey(
      { channel: "C123", ts: "1.0", bot_id: "B42" },
      ACCOUNT,
    );
    expect(key).not.toBeNull();
    expect(key).toContain("B42");
  });

  test("event_ts is used when ts is missing", () => {
    const key = buildSlackDebounceKey(
      { channel: "C123", event_ts: "1.0", user: "U1" },
      ACCOUNT,
    );
    expect(key).not.toBeNull();
    expect(key).toContain("1.0");
  });

  test("accountId scopes the key (different accounts → different keys)", () => {
    const k1 = buildSlackDebounceKey(
      { channel: "D123", ts: "1.0", user: "U1" },
      "acct-a",
    );
    const k2 = buildSlackDebounceKey(
      { channel: "D123", ts: "1.0", user: "U1" },
      "acct-b",
    );
    expect(k1).not.toBe(k2);
  });
});

describe("buildTopLevelSlackConversationKey", () => {
  test("returns a key for top-level channel posts", () => {
    const key = buildTopLevelSlackConversationKey(
      { channel: "C123", ts: "1.0", user: "U1" },
      ACCOUNT,
    );
    expect(key).not.toBeNull();
  });

  test("returns null for DMs", () => {
    const key = buildTopLevelSlackConversationKey(
      { channel: "D123", ts: "1.0", user: "U1" },
      ACCOUNT,
    );
    expect(key).toBeNull();
  });

  test("returns null for thread replies", () => {
    const key = buildTopLevelSlackConversationKey(
      {
        channel: "C123",
        ts: "1.0",
        thread_ts: "0.9",
        user: "U1",
      },
      ACCOUNT,
    );
    expect(key).toBeNull();
  });

  test("returns null when parent_user_id is set (maybe-thread case)", () => {
    const key = buildTopLevelSlackConversationKey(
      {
        channel: "C123",
        ts: "1.0",
        parent_user_id: "U_parent",
        user: "U1",
      },
      ACCOUNT,
    );
    expect(key).toBeNull();
  });

  test("returns null when sender is missing", () => {
    const key = buildTopLevelSlackConversationKey(
      { channel: "C123", ts: "1.0" },
      ACCOUNT,
    );
    expect(key).toBeNull();
  });
});

describe("resolveSlackInboundDebounceMs", () => {
  const originalEnv = process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS;

  function clearEnv() {
    delete process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS;
  }

  function restoreEnv() {
    if (originalEnv === undefined) clearEnv();
    else process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS = originalEnv;
  }

  test("defaults to 0 when no env var and no config value", () => {
    clearEnv();
    expect(resolveSlackInboundDebounceMs({})).toBe(0);
    restoreEnv();
  });

  test("returns config value when env is unset", () => {
    clearEnv();
    expect(resolveSlackInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(
      1500,
    );
    restoreEnv();
  });

  test("env var overrides config", () => {
    clearEnv();
    process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS = "2500";
    expect(resolveSlackInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(
      2500,
    );
    restoreEnv();
  });

  test("env var of 0 is respected (disables debounce even with config set)", () => {
    clearEnv();
    process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS = "0";
    expect(resolveSlackInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(0);
    restoreEnv();
  });

  test("invalid env var falls back to config", () => {
    clearEnv();
    process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS = "not-a-number";
    expect(resolveSlackInboundDebounceMs({ inboundDebounceMs: 800 })).toBe(800);
    restoreEnv();
  });

  test("negative config value falls back to 0", () => {
    clearEnv();
    expect(resolveSlackInboundDebounceMs({ inboundDebounceMs: -500 })).toBe(0);
    restoreEnv();
  });

  test("empty-string env var is treated as unset", () => {
    clearEnv();
    process.env.LETTA_SLACK_INBOUND_DEBOUNCE_MS = "";
    expect(resolveSlackInboundDebounceMs({ inboundDebounceMs: 1234 })).toBe(
      1234,
    );
    restoreEnv();
  });
});
