import { expect, test } from "bun:test";
import {
  __testOverrideSubmitChannelFeedback,
  handleChannelFeedbackCommand,
} from "@/channels/feedback";
import type { ChannelRoute, InboundChannelMessage } from "@/channels/types";

test("channel feedback displays a rejection instead of success", async () => {
  __testOverrideSubmitChannelFeedback(async () => ({
    success: false,
    status: "rejected",
    message: "Fixture rejection. Do not retry.",
  }));
  try {
    const result = await handleChannelFeedbackCommand({
      msg: { channel: "slack" } as InboundChannelMessage,
      command: { args: "fixture feedback" },
      route: {
        enabled: true,
        agentId: "fixture-agent",
        conversationId: "fixture-conversation",
      } as ChannelRoute,
    });
    expect(result).toBe("Fixture rejection. Do not retry.");
  } finally {
    __testOverrideSubmitChannelFeedback(null);
  }
});
