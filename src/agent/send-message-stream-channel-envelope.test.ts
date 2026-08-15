import { afterEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { Backend } from "@/backend";
import { buildGatewayMessageChannelTool } from "@/channels/message-channel-gateway-tool";
import type { InboundChannelMessage } from "@/channels/types";
import { formatChannelNotification } from "@/channels/xml";
import {
  clearCapturedToolExecutionContexts,
  clearExternalTools,
  clearTools,
  prepareToolExecutionContextForModel,
  registerExternalTools,
} from "@/tools/manager";
import { sendMessageStreamWithBackend } from "./message";

describe("channel request envelope", () => {
  afterEach(() => {
    clearCapturedToolExecutionContexts();
    clearExternalTools();
    clearTools();
  });

  test("keeps reply guidance in MessageChannel without a durable reminder", async () => {
    const inboundMessage: InboundChannelMessage = {
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      senderId: "U123",
      senderName: "Cameron",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      text: "Can you investigate this?",
      timestamp: Date.now(),
    };
    const messageChannelTool = await buildGatewayMessageChannelTool([
      {
        channel: "slack",
        accountId: inboundMessage.accountId,
        chatId: inboundMessage.chatId,
        chatType: inboundMessage.chatType,
        messageId: inboundMessage.messageId,
        threadId: inboundMessage.threadId,
        agentId: "agent-1",
        conversationId: "conv-slack",
      },
    ]);
    if (!messageChannelTool) {
      throw new Error("Gateway did not build MessageChannel");
    }
    registerExternalTools([
      {
        ...messageChannelTool,
        runtime: { agentId: "agent-1", conversationId: "conv-slack" },
      },
    ]);
    const preparedToolContext = await prepareToolExecutionContextForModel(
      "anthropic/claude-opus-4-1-20250805",
      {
        clientToolAllowlist: ["MessageChannel"],
        runtimeContext: {
          agentId: "agent-1",
          conversationId: "conv-slack",
        },
      },
    );

    let recordedBody: MessageCreateParams | undefined;
    const stream = {
      async *[Symbol.asyncIterator]() {},
    } as unknown as Stream<LettaStreamingResponse>;
    const backend = {
      createConversationMessageStream: async (
        _conversationId: string,
        body: MessageCreateParams,
      ) => {
        recordedBody = body;
        return stream;
      },
    } as unknown as Backend;

    await sendMessageStreamWithBackend(
      backend,
      "conv-slack",
      [{ role: "user", content: formatChannelNotification(inboundMessage) }],
      {
        streamTokens: true,
        background: true,
        skillSources: [],
        preparedToolContext,
      },
    );

    const requestText = JSON.stringify(recordedBody?.messages);
    const messageChannel = recordedBody?.client_tools?.find(
      (tool) => tool.name === "MessageChannel",
    );
    const replyGuidance =
      "Replies to routed Slack threads stay in the current thread automatically.";

    expect(requestText).not.toContain("External slack turn.");
    expect(requestText).not.toContain("Current local time on this device:");
    expect(requestText).toContain('source=\\"slack\\"');
    expect(requestText).toContain('chat_id=\\"C123\\"');
    expect(requestText).toContain('thread_id=\\"1712790000.000050\\"');
    expect(requestText).not.toContain(replyGuidance);
    expect(requestText).not.toContain('action=\\"react\\"');

    expect(messageChannel).toBeDefined();
    if (!messageChannel?.description) {
      throw new Error("MessageChannel tool is missing its description");
    }
    expect(messageChannel.description).toContain(replyGuidance);
    expect(messageChannel.description.split(replyGuidance)).toHaveLength(2);
    expect(messageChannel.description).toContain(
      "For Slack requests that require nontrivial work or several tool calls",
    );
    const properties = messageChannel.parameters?.properties as
      | Record<string, unknown>
      | undefined;
    expect(properties?.target).toBeDefined();
  });
});
