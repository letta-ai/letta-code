import { describe, expect, test } from "bun:test";
import type { WhatsAppChannelAccount } from "@/channels/types";
import { whatsappAccountConfigAdapter } from "@/channels/whatsapp/account-config";

function makeWhatsAppAccount(
  overrides: Partial<WhatsAppChannelAccount> = {},
): WhatsAppChannelAccount {
  return {
    channel: "whatsapp",
    accountId: "acct-whatsapp",
    displayName: "WhatsApp",
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    agentId: "agent-whatsapp",
    selfChatMode: true,
    groupMode: "disabled",
    transcribeVoice: false,
    downloadMedia: false,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("whatsappAccountConfigAdapter message_prefix", () => {
  test("accepts and round-trips a string prefix", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        message_prefix: "🤖 ",
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({
        message_prefix: "🤖 ",
      }),
    ).toMatchObject({ messagePrefix: "🤖 " });
  });

  test("rejects non-string values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ message_prefix: 123 }),
    ).toBe(false);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ message_prefix: true }),
    ).toBe(false);
  });

  test("undefined preserves backward compat (not in patch)", () => {
    expect(whatsappAccountConfigAdapter.isValidConfig({})).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({}).messagePrefix,
    ).toBeUndefined();
  });

  test("surfaces in account config snapshot", () => {
    expect(
      whatsappAccountConfigAdapter.toAccountConfig(
        makeWhatsAppAccount({ messagePrefix: "✨ " }),
      ),
    ).toMatchObject({ message_prefix: "✨ " });
    expect(
      whatsappAccountConfigAdapter.toConfigSnapshotConfig(
        makeWhatsAppAccount({ messagePrefix: "✨ " }),
      ),
    ).toMatchObject({ message_prefix: "✨ " });
  });

  test("omits message_prefix from snapshot when undefined", () => {
    expect(
      whatsappAccountConfigAdapter.toAccountConfig(makeWhatsAppAccount())
        .message_prefix,
    ).toBeUndefined();
  });
});

describe("whatsappAccountConfigAdapter inbound_debounce_ms", () => {
  test("accepts 0 (disabled default)", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ inbound_debounce_ms: 0 }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({ inbound_debounce_ms: 0 }),
    ).toMatchObject({ inboundDebounceMs: 0 });
  });

  test("accepts values within 0..10000", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ inbound_debounce_ms: 500 }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        inbound_debounce_ms: 10000,
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({ inbound_debounce_ms: 750 }),
    ).toMatchObject({ inboundDebounceMs: 750 });
  });

  test("truncates fractional values", () => {
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({
        inbound_debounce_ms: 750.9,
      }),
    ).toMatchObject({ inboundDebounceMs: 750 });
  });

  test("rejects values above 10000", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        inbound_debounce_ms: 10001,
      }),
    ).toBe(false);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        inbound_debounce_ms: 99999,
      }),
    ).toBe(false);
  });

  test("rejects negative values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ inbound_debounce_ms: -1 }),
    ).toBe(false);
  });

  test("rejects non-number values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        inbound_debounce_ms: "500",
      }),
    ).toBe(false);
  });

  test("undefined preserves backward compat", () => {
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({}).inboundDebounceMs,
    ).toBeUndefined();
  });

  test("surfaces in account config snapshot", () => {
    expect(
      whatsappAccountConfigAdapter.toAccountConfig(
        makeWhatsAppAccount({ inboundDebounceMs: 2000 }),
      ),
    ).toMatchObject({ inbound_debounce_ms: 2000 });
  });
});

describe("whatsappAccountConfigAdapter waiting_behavior", () => {
  test("accepts 'off'", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ waiting_behavior: "off" }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({
        waiting_behavior: "off",
      }),
    ).toMatchObject({ waitingBehavior: "off" });
  });

  test("accepts 'typing_indicator'", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "typing_indicator",
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({
        waiting_behavior: "typing_indicator",
      }),
    ).toMatchObject({ waitingBehavior: "typing_indicator" });
  });

  test("rejects 'message' (not in scope)", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "message",
      }),
    ).toBe(false);
  });

  test("rejects unknown string values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "something_else",
      }),
    ).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ waiting_behavior: 1 }),
    ).toBe(false);
  });

  test("undefined preserves backward compat (defaults to 'off' at runtime)", () => {
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({}).waitingBehavior,
    ).toBeUndefined();
  });

  test("surfaces in account config snapshot", () => {
    expect(
      whatsappAccountConfigAdapter.toAccountConfig(
        makeWhatsAppAccount({ waitingBehavior: "typing_indicator" }),
      ),
    ).toMatchObject({ waiting_behavior: "typing_indicator" });
  });
});

describe("whatsappAccountConfigAdapter combined round-trip", () => {
  test("all three keys round-trip snake_case → camelCase → snake_case", () => {
    const snakeConfig = {
      message_prefix: "🤖 ",
      inbound_debounce_ms: 1500,
      waiting_behavior: "typing_indicator" as const,
    };

    // Validate
    expect(whatsappAccountConfigAdapter.isValidConfig(snakeConfig)).toBe(true);

    // toAccountPatch: snake → camel
    const patch = whatsappAccountConfigAdapter.toAccountPatch(snakeConfig);
    expect(patch).toMatchObject({
      messagePrefix: "🤖 ",
      inboundDebounceMs: 1500,
      waitingBehavior: "typing_indicator",
    });

    // Build an account from the patch, then toAccountConfig: camel → snake
    const account = makeWhatsAppAccount({
      messagePrefix: patch.messagePrefix,
      inboundDebounceMs: patch.inboundDebounceMs,
      waitingBehavior: patch.waitingBehavior,
    });
    const roundTripped = whatsappAccountConfigAdapter.toAccountConfig(account);
    expect(roundTripped).toMatchObject(snakeConfig);

    // Config snapshot matches too
    const snapshot =
      whatsappAccountConfigAdapter.toConfigSnapshotConfig(account);
    expect(snapshot).toMatchObject(snakeConfig);
  });

  test("unknown config keys are rejected", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        message_prefix: "🤖 ",
        unknown_key: true,
      }),
    ).toBe(false);
  });
});
