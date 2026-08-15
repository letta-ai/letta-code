import { describe, expect, mock, test } from "bun:test";
import { createSlackMessageActionAdapter } from "@/channels-slack";
import {
  buildMessageChannelExternalToolDefinition,
  executeMessageChannel,
  executeMessageChannelExternalTool,
  type MessageChannelExecutionResolver,
} from "@/gateway-core";
import type { ChannelMessageActionTransport } from "./plugin-types";

function createSlackActions() {
  return createSlackMessageActionAdapter({ react: true });
}

describe("external MessageChannel gateway boundary", () => {
  test("builds the canonical scoped tool from host-supported Slack actions", () => {
    const definition = buildMessageChannelExternalToolDefinition({
      scoped: true,
      channels: [
        {
          channelId: "slack",
          displayName: "Slack",
          accountId: "generated-app-1",
          messageActions: createSlackActions(),
        },
      ],
    });

    expect(definition.name).toBe("MessageChannel");
    expect(definition.label).toBe("Message Channel");
    expect(definition.description).toContain(
      "Plain assistant text is not delivered to that external user.",
    );
    expect(definition.description).toContain(
      "After that final send succeeds, do not repeat or paraphrase the sent message in assistant text; finish with only `Sent.` as the internal confirmation.",
    );
    expect(definition.description).toContain(
      "This does not apply to a short acknowledgement sent before continuing substantive work.",
    );
    expect(definition.description).toContain(
      "Replies to routed Slack threads stay in the current thread automatically.",
    );
    expect(definition.description).not.toContain("`upload-file`");
    expect(definition.description).not.toContain('action="download-file"');
    expect(definition.description).not.toContain("Proactive mode");

    const properties = definition.parameters.properties as Record<
      string,
      { description?: string; enum?: string[] }
    >;
    expect(properties.channel?.enum).toEqual(["slack"]);
    expect(properties.channel?.description).toBe(
      "Channel to send the message to. Available channels: slack.",
    );
    expect(properties.accountId?.enum).toEqual(["generated-app-1"]);
    expect(properties.action?.enum).toEqual(["send", "react"]);
    expect(properties.messageId).toBeDefined();
    expect(properties.attachmentId).toBeUndefined();
    expect(properties.target).toBeUndefined();
    expect(properties.media).toBeUndefined();
    expect(properties.filename).toBeUndefined();
    expect(properties.title).toBeUndefined();
    expect(properties.action?.description).not.toContain("upload-file");
  });

  test("executes canonical account, thread, formatting, and Slack action behavior without the local registry", async () => {
    const sendMessage = mock(async () => ({ messageId: "slack-response-1" }));
    const transport: ChannelMessageActionTransport = { sendMessage };
    const resolveRoutedContext = mock(
      async (): Promise<
        Exclude<
          Awaited<
            ReturnType<MessageChannelExecutionResolver["resolveRoutedContext"]>
          >,
          string | null
        >
      > => ({
        route: {
          accountId: "generated-app-1",
          chatId: "C123",
          chatType: "channel",
          threadId: null,
          agentId: "agent-1",
          conversationId: "conv-1",
        },
        transport,
        messageActions: createSlackActions(),
      }),
    );
    const resolver: MessageChannelExecutionResolver = {
      isSupportedChannel: (channel) => channel === "slack",
      resolveRoutedContext,
      resolveProactiveContext: () =>
        "Error: Proactive sends are disabled in this test host.",
    };

    const externalToolInput: Record<string, unknown> = {
      action: "SEND",
      channel: "SLACK",
      chat_id: "channel:C123",
      message: "**hello** from Cloud",
    };
    const result = await executeMessageChannel(externalToolInput, {
      resolver,
      scope: { agentId: "agent-1", conversationId: "conv-1" },
      channelTurnSources: [
        {
          channel: "slack",
          accountId: "generated-app-1",
          chatId: "C123",
          chatType: "channel",
          messageId: "1712800000.000100",
          threadId: null,
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      ],
    });

    expect(result).toBe("Message sent to slack (message_id: slack-response-1)");
    expect(resolveRoutedContext).toHaveBeenCalledWith({
      channel: "slack",
      chatId: "C123",
      accountId: "generated-app-1",
      scope: { agentId: "agent-1", conversationId: "conv-1" },
    });
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "generated-app-1",
      chatId: "C123",
      text: "*hello* from Cloud",
      replyToMessageId: undefined,
      threadId: "1712800000.000100",
      mediaPath: undefined,
      fileName: undefined,
      title: undefined,
      parseMode: undefined,
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    const externalResult = await executeMessageChannelExternalTool(
      externalToolInput,
      {
        resolver,
        scope: { agentId: "agent-1", conversationId: "conv-1" },
        channelTurnSources: [
          {
            channel: "slack",
            accountId: "generated-app-1",
            chatId: "C123",
            chatType: "channel",
            messageId: "1712800000.000100",
            threadId: null,
            agentId: "agent-1",
            conversationId: "conv-1",
          },
        ],
      },
    );
    expect(externalResult).toEqual({
      content: [
        {
          type: "text",
          text: "Message sent to slack (message_id: slack-response-1)",
        },
      ],
      is_error: false,
    });
  });

  test("returns canonical external-tool validation and routing errors", async () => {
    const resolver: MessageChannelExecutionResolver = {
      isSupportedChannel: (channel) => channel === "slack",
      resolveRoutedContext: () => null,
    };
    const options = {
      resolver,
      scope: { agentId: "agent-1", conversationId: "conv-1" },
    };

    const validationError = await executeMessageChannelExternalTool(
      { action: "send", channel: "slack", message: "missing destination" },
      options,
    );
    expect(validationError).toEqual({
      content: [
        {
          type: "text",
          text: "Error: MessageChannel requires exactly one of chat_id or target.",
        },
      ],
      is_error: true,
    });

    const noRoute = await executeMessageChannelExternalTool(
      {
        action: "send",
        channel: "slack",
        chat_id: "C123",
        message: "hello",
      },
      options,
    );
    expect(noRoute.is_error).toBe(true);
    expect(noRoute.content[0]?.text).toStartWith("Error: No route");
  });

  test("marks transport failures as external-tool errors", async () => {
    const resolver: MessageChannelExecutionResolver = {
      isSupportedChannel: (channel) => channel === "slack",
      resolveRoutedContext: () => ({
        route: {
          accountId: "generated-app-1",
          chatId: "C123",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
        transport: {
          sendMessage: async () => {
            throw new Error("Slack unavailable");
          },
        },
        messageActions: createSlackActions(),
      }),
    };

    const result = await executeMessageChannelExternalTool(
      {
        action: "send",
        channel: "slack",
        chat_id: "C123",
        message: "hello",
      },
      {
        resolver,
        scope: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Error: Sending message to slack failed: Slack unavailable",
        },
      ],
      is_error: true,
    });
  });

  test("rejects a host route outside the runtime scope before transport execution", async () => {
    const sendMessage = mock(async () => ({ messageId: "must-not-send" }));
    const resolver: MessageChannelExecutionResolver = {
      isSupportedChannel: (channel) => channel === "slack",
      resolveRoutedContext: () => ({
        route: {
          accountId: "generated-app-1",
          chatId: "C123",
          agentId: "other-agent",
          conversationId: "other-conversation",
        },
        transport: { sendMessage },
        messageActions: createSlackActions(),
      }),
      resolveProactiveContext: () => "unused",
    };

    const result = await executeMessageChannel(
      {
        action: "send",
        channel: "slack",
        chat_id: "C123",
        message: "do not send",
      },
      {
        resolver,
        scope: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    expect(result).toBe(
      "Error: Resolved MessageChannel route is outside the current execution scope.",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("rejects a host route from a different channel account", async () => {
    const sendMessage = mock(async () => ({ messageId: "must-not-send" }));
    const resolver: MessageChannelExecutionResolver = {
      isSupportedChannel: (channel) => channel === "slack",
      resolveRoutedContext: () => ({
        route: {
          accountId: "other-app",
          chatId: "C123",
          agentId: "agent-1",
          conversationId: "conv-1",
        },
        transport: { sendMessage },
        messageActions: createSlackActions(),
      }),
    };

    const result = await executeMessageChannel(
      {
        action: "send",
        channel: "slack",
        chat_id: "C123",
        accountId: "generated-app-1",
        message: "do not send",
      },
      {
        resolver,
        scope: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    expect(result).toBe(
      "Error: Resolved MessageChannel route is outside the current execution scope.",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("builds a scoped proactive route around the host-resolved Slack target", async () => {
    const sendMessage = mock(async () => ({ messageId: "proactive-1" }));
    const resolver: MessageChannelExecutionResolver = {
      isSupportedChannel: (channel) => channel === "slack",
      resolveRoutedContext: () => null,
      resolveProactiveContext: () => ({
        accountId: "generated-app-1",
        target: {
          chatId: "C999",
          chatType: "channel",
          threadId: null,
        },
        transport: { sendMessage },
        messageActions: createSlackActions(),
      }),
    };

    const result = await executeMessageChannel(
      {
        action: "send",
        channel: "slack",
        target: "#eng",
        message: "deployment complete",
      },
      {
        resolver,
        scope: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    expect(result).toBe("Message sent to slack (message_id: proactive-1)");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "generated-app-1",
        chatId: "C999",
        agentId: "agent-1",
        conversationId: "conv-1",
      }),
    );
  });
});
