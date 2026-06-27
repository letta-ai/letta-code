import { describe, expect, test } from "bun:test";

import { telegramAccountConfigAdapter } from "@/channels/telegram/account-config";
import type { TelegramChannelAccount } from "@/channels/types";

function makeTelegramAccount(
  overrides: Partial<TelegramChannelAccount> = {},
): TelegramChannelAccount {
  return {
    channel: "telegram",
    accountId: "acct-telegram",
    displayName: "Telegram",
    enabled: true,
    token: "telegram-token",
    dmPolicy: "pairing",
    allowedUsers: [],
    binding: {
      agentId: null,
      conversationId: null,
    },
    groupMode: "open",
    transcribeVoice: false,
    richPrivateChatDefault: true,
    richDraftStreaming: false,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("telegramAccountConfigAdapter rich private chat default", () => {
  test("accepts and maps rich_private_chat_default", () => {
    expect(
      telegramAccountConfigAdapter.isValidConfig({
        rich_private_chat_default: false,
      }),
    ).toBe(true);
    expect(
      telegramAccountConfigAdapter.toAccountPatch({
        rich_private_chat_default: false,
      }),
    ).toMatchObject({
      richPrivateChatDefault: false,
    });
  });

  test("rejects non-boolean rich_private_chat_default values", () => {
    expect(
      telegramAccountConfigAdapter.isValidConfig({
        rich_private_chat_default: "false",
      }),
    ).toBe(false);
  });

  test("surfaces rich_private_chat_default in safe snapshots", () => {
    expect(
      telegramAccountConfigAdapter.toAccountConfig(
        makeTelegramAccount({ richPrivateChatDefault: false }),
      ),
    ).toMatchObject({
      rich_private_chat_default: false,
    });
    expect(
      telegramAccountConfigAdapter.toConfigSnapshotConfig(
        makeTelegramAccount(),
      ),
    ).toMatchObject({
      rich_private_chat_default: true,
    });
  });
});
