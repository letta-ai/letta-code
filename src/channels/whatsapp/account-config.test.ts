import { describe, expect, test } from "bun:test";
import type { WhatsAppChannelAccount } from "@/channels/types";
import { whatsappAccountConfigAdapter } from "./account-config";

function account(
  overrides: Partial<WhatsAppChannelAccount> = {},
): WhatsAppChannelAccount {
  return {
    channel: "whatsapp",
    accountId: "wa-test",
    displayName: "WhatsApp",
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    agentId: null,
    selfChatMode: true,
    groupMode: "disabled",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("WhatsApp inbound debounce account config", () => {
  test("accepts the finite range and truncates fractional values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        inbound_debounce_ms: 0,
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        inbound_debounce_ms: 10000,
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({
        inbound_debounce_ms: 1250.9,
      }),
    ).toEqual({ inboundDebounceMs: 1250 });
  });

  test("rejects invalid values and unknown nested fields", () => {
    for (const value of [
      "100",
      null,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10001,
    ]) {
      expect(
        whatsappAccountConfigAdapter.isValidConfig({
          inbound_debounce_ms: value,
        }),
      ).toBe(false);
    }
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ unexpected: true }),
    ).toBe(false);
  });

  test("defaults absent account values to zero in persisted config", () => {
    expect(
      whatsappAccountConfigAdapter.toAccountConfig(account()),
    ).toMatchObject({ inbound_debounce_ms: 0 });
    expect(
      whatsappAccountConfigAdapter.toConfigSnapshotConfig(
        account({ inboundDebounceMs: 42 }),
      ),
    ).toMatchObject({ inbound_debounce_ms: 42 });
  });
});
