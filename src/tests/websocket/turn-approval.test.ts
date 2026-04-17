import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "../../websocket/listen-client";
import { resolveChannelApprovalSource } from "../../websocket/listener/turn-approval";

describe("resolveChannelApprovalSource", () => {
  test("keeps channel approvals attached when coalesced messages share one logical scope", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeChannelTurnSources = [
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000200",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ];

    expect(resolveChannelApprovalSource(runtime)).toEqual(
      runtime.activeChannelTurnSources[1] ?? null,
    );
  });

  test("falls back to websocket approval when a coalesced turn spans multiple channel scopes", () => {
    const runtime = __listenClientTestUtils.createRuntime();
    runtime.activeChannelTurnSources = [
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      {
        channel: "telegram",
        accountId: "acct-telegram",
        chatId: "987654",
        chatType: "direct",
        messageId: "42",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ];

    expect(resolveChannelApprovalSource(runtime)).toBeNull();
  });
});
