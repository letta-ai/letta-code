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
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("WhatsApp message prefix config", () => {
  test("accepts empty and non-empty strings and round-trips them", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ message_prefix: "" }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ message_prefix: "[bot] " }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({ message_prefix: "[bot] " }),
    ).toEqual({ messagePrefix: "[bot] " });
    expect(
      whatsappAccountConfigAdapter.toAccountConfig(
        account({ messagePrefix: "[bot] " }),
      ).message_prefix,
    ).toBe("[bot] ");
    expect(
      whatsappAccountConfigAdapter.toConfigSnapshotConfig(
        account({ messagePrefix: "" }),
      ).message_prefix,
    ).toBe("");
  });

  test("rejects non-strings and unknown nested fields", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ message_prefix: true }),
    ).toBe(false);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ message_prefix: 1 }),
    ).toBe(false);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ unexpected: true }),
    ).toBe(false);
  });
});
