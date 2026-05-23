import { afterEach, describe, expect, test } from "bun:test";
import {
  buildTelegramDebounceKey,
  resolveTelegramInboundDebounceMs,
} from "@/channels/telegram/debounce";

const ACCOUNT = "telegram-account";

describe("buildTelegramDebounceKey", () => {
  test("groups by account and chat for non-topic messages", () => {
    expect(buildTelegramDebounceKey({ chatId: "-100123" }, ACCOUNT)).toBe(
      "telegram:telegram-account:-100123:main",
    );
  });

  test("groups forum topic messages by thread id", () => {
    expect(
      buildTelegramDebounceKey(
        { chatId: "-100123", threadId: "42" },
        ACCOUNT,
      ),
    ).toBe("telegram:telegram-account:-100123:42");
  });

  test("returns null for missing chat id", () => {
    expect(buildTelegramDebounceKey({ chatId: "" }, ACCOUNT)).toBeNull();
  });
});

describe("resolveTelegramInboundDebounceMs", () => {
  const originalEnv = process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;
    } else {
      process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS = originalEnv;
    }
  });

  test("defaults to 0", () => {
    delete process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;
    expect(resolveTelegramInboundDebounceMs({})).toBe(0);
  });

  test("uses account config when env is unset", () => {
    delete process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;
    expect(resolveTelegramInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(
      1500,
    );
  });

  test("env var overrides config", () => {
    process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS = "2500";
    expect(resolveTelegramInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(
      2500,
    );
  });

  test("clamps config and env values", () => {
    delete process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;
    expect(resolveTelegramInboundDebounceMs({ inboundDebounceMs: 50_000 })).toBe(
      10_000,
    );
    process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS = "50000";
    expect(resolveTelegramInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(
      10_000,
    );
  });

  test("invalid and negative values fall back", () => {
    process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS = "nope";
    expect(resolveTelegramInboundDebounceMs({ inboundDebounceMs: 800 })).toBe(
      800,
    );
    delete process.env.LETTA_TELEGRAM_INBOUND_DEBOUNCE_MS;
    expect(resolveTelegramInboundDebounceMs({ inboundDebounceMs: -1 })).toBe(0);
  });
});
