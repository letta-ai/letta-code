import { describe, expect, test } from "bun:test";
import { LEGACY_CHANNEL_ACCOUNT_ID } from "@/channels/accounts";
import type { ChannelTurnSource } from "@/channels/types";
import { findDeliveryGrantSource } from "./message-channel-grants";

const SCOPE = { agentId: "agent-a", conversationId: "conv-fire-1" };

function makeSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "telegram",
    chatId: "111",
    agentId: SCOPE.agentId,
    conversationId: SCOPE.conversationId,
    ...overrides,
  };
}

describe("findDeliveryGrantSource", () => {
  test("matches a source attested for the exact scope and chat", () => {
    const grant = findDeliveryGrantSource({
      channel: "telegram",
      chatId: "111",
      scope: SCOPE,
      channelTurnSources: [makeSource()],
    });
    expect(grant).not.toBeNull();
  });

  test("rejects sources for a different chat, channel, or scope", () => {
    const cases: ChannelTurnSource[] = [
      makeSource({ chatId: "999" }),
      makeSource({ channel: "slack" }),
      makeSource({ agentId: "agent-b" }),
      makeSource({ conversationId: "other-conversation" }),
    ];
    for (const source of cases) {
      expect(
        findDeliveryGrantSource({
          channel: "telegram",
          chatId: "111",
          scope: SCOPE,
          channelTurnSources: [source],
        }),
      ).toBeNull();
    }
  });

  test("returns null with no sources", () => {
    expect(
      findDeliveryGrantSource({
        channel: "telegram",
        chatId: "111",
        scope: SCOPE,
      }),
    ).toBeNull();
    expect(
      findDeliveryGrantSource({
        channel: "telegram",
        chatId: "111",
        scope: SCOPE,
        channelTurnSources: [],
      }),
    ).toBeNull();
  });

  test("enforces a requested account id with legacy normalization", () => {
    const legacySource = makeSource();
    expect(
      findDeliveryGrantSource({
        channel: "telegram",
        chatId: "111",
        accountId: LEGACY_CHANNEL_ACCOUNT_ID,
        scope: SCOPE,
        channelTurnSources: [legacySource],
      }),
    ).not.toBeNull();

    const accountSource = makeSource({ accountId: "acct_1" });
    expect(
      findDeliveryGrantSource({
        channel: "telegram",
        chatId: "111",
        accountId: "acct_1",
        scope: SCOPE,
        channelTurnSources: [accountSource],
      }),
    ).not.toBeNull();
    expect(
      findDeliveryGrantSource({
        channel: "telegram",
        chatId: "111",
        accountId: "acct_2",
        scope: SCOPE,
        channelTurnSources: [accountSource],
      }),
    ).toBeNull();
  });
});
