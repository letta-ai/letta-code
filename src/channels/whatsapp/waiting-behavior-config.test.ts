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

describe("WhatsApp waiting behavior config", () => {
  test("accepts and round-trips the supported values", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "off",
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "typing_indicator",
      }),
    ).toBe(true);
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({
        waiting_behavior: "typing_indicator",
      }),
    ).toEqual({ waitingBehavior: "typing_indicator" });
    expect(
      whatsappAccountConfigAdapter.toAccountPatch({ waiting_behavior: "off" }),
    ).toEqual({ waitingBehavior: "off" });
    expect(
      whatsappAccountConfigAdapter.toAccountConfig(
        account({ waitingBehavior: "typing_indicator" }),
      ).waiting_behavior,
    ).toBe("typing_indicator");
  });

  test("rejects unknown values and defaults absent values to off", () => {
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: "always",
      }),
    ).toBe(false);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({
        waiting_behavior: true,
      }),
    ).toBe(false);
    expect(
      whatsappAccountConfigAdapter.isValidConfig({ unexpected: true }),
    ).toBe(false);
    expect(
      whatsappAccountConfigAdapter.toConfigSnapshotConfig(account())
        .waiting_behavior,
    ).toBe("off");
  });
});
