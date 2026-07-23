import { describe, expect, test } from "bun:test";
import type { ChannelTurnSource } from "@/channels/types";
import {
  channelTurnSourceIdentity,
  effectiveChannelTurnSourceThreadId,
} from "./turn-source";

function turnSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "slack",
    accountId: "account-1",
    chatId: "C123",
    chatType: "channel",
    senderId: "U123",
    senderTeamId: "T123",
    messageId: "1712790000.000050",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conversation-1",
    ...overrides,
  };
}

describe("channel turn source helpers", () => {
  test("identity includes all provenance fields", () => {
    const source = turnSource();

    expect(channelTurnSourceIdentity({ ...source })).toBe(
      channelTurnSourceIdentity(source),
    );
    expect(channelTurnSourceIdentity({ ...source, senderId: "U456" })).not.toBe(
      channelTurnSourceIdentity(source),
    );
    expect(
      channelTurnSourceIdentity({ ...source, senderTeamId: "T456" }),
    ).not.toBe(channelTurnSourceIdentity(source));
    expect(
      channelTurnSourceIdentity({ ...source, chatType: "direct" }),
    ).not.toBe(channelTurnSourceIdentity(source));
  });

  test("uses Slack root messages as effective thread identifiers", () => {
    expect(effectiveChannelTurnSourceThreadId(turnSource())).toBe(
      "1712790000.000050",
    );
    expect(
      effectiveChannelTurnSourceThreadId(turnSource({ threadId: "root-ts" })),
    ).toBe("root-ts");
    expect(
      effectiveChannelTurnSourceThreadId(
        turnSource({ channel: "telegram", threadId: null }),
      ),
    ).toBeNull();
  });
});
