import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __testOverrideLoadPendingControlRequestStore,
  __testOverrideSavePendingControlRequestStore,
  clearPendingControlRequestStore,
} from "@/channels/pending-control-requests";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import { addRoute, clearAllRoutes } from "@/channels/routing";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  InboundChannelMessage,
} from "@/channels/types";
import {
  getInteractiveApprovalKind,
  isInteractiveApprovalTool,
} from "@/tools/interactive-policy";

beforeEach(() => {
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

afterEach(() => {
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

const QUESTION_TEXT = "Which deployment strategy should we use?";
const QUESTION_HEADER = "Deployment";
const OPTIONS = [
  { label: "Blue-green", description: "Zero-downtime switch" },
  { label: "Rolling", description: "Gradual rollout" },
  { label: "Canary", description: "Incremental traffic shift" },
];

function createMessageChannelAskInput(): Record<string, unknown> {
  return {
    action: "ask",
    channel: "slack",
    chat_id: "C789",
    questions: [
      {
        question: QUESTION_TEXT,
        header: QUESTION_HEADER,
        options: OPTIONS,
        multiSelect: false,
      },
    ],
  };
}

function createMessageChannelAskEvent(): ChannelControlRequestEvent {
  return {
    requestId: "perm-msg-ch-ask-1",
    kind: "ask_user_question",
    source: {
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C789",
      chatType: "channel",
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
    },
    toolName: "MessageChannel",
    input: createMessageChannelAskInput(),
  };
}

function createInboundReply(
  text: string,
  overrides: Partial<InboundChannelMessage> = {},
): InboundChannelMessage {
  return {
    channel: "slack",
    accountId: "acct-slack",
    chatId: "C789",
    senderId: "U123",
    senderName: "Charles",
    text,
    timestamp: Date.now(),
    messageId: "1712800000.000200",
    threadId: "1712790000.000050",
    chatType: "channel",
    ...overrides,
  };
}

function createAdapter(
  replies: Array<{ chatId: string; text: string; replyToMessageId?: string }>,
): ChannelAdapter {
  return {
    id: "slack:acct-slack",
    channelId: "slack",
    accountId: "acct-slack",
    name: "Slack",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "msg-1" }),
    sendDirectReply: async (chatId, text, options) => {
      replies.push({
        chatId,
        text,
        replyToMessageId: options?.replyToMessageId,
      });
    },
    handleControlRequestEvent: async () => {},
    onMessage: undefined,
  };
}

describe("MessageChannel action=ask integration path", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
  });

  test("args-aware classification yields kind ask_user_question for MessageChannel ask", () => {
    const input = createMessageChannelAskInput();

    expect(isInteractiveApprovalTool("MessageChannel", input)).toBe(true);
    expect(
      isInteractiveApprovalTool("MessageChannel", { action: "send" }),
    ).toBe(false);

    const kind = getInteractiveApprovalKind("MessageChannel", input);
    expect(kind).toBe("ask_user_question");

    // Non-ask actions should not classify as interactive.
    expect(
      getInteractiveApprovalKind("MessageChannel", { action: "send" }),
    ).toBe(null);
  });

  test("registerPendingControlRequest stores MessageChannel ask input and intercepts channel replies", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });

    const approvalResponses: Array<{
      runtime: { agent_id?: string | null; conversation_id?: string | null };
      response: unknown;
    }> = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });

    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C789",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });

    // Register the pending control request as the listener would:
    // kind comes from getInteractiveApprovalKind, input is the parsed
    // MessageChannel tool args (including action, channel, chat_id, questions).
    const event = createMessageChannelAskEvent();
    await registry.registerPendingControlRequest(event);

    // The registry should now have the pending request.
    expect(registry.hasPendingControlRequest(event.requestId)).toBe(true);

    // Simulate a channel reply: "3" maps to the third option "Canary".
    await adapter.onMessage?.(createInboundReply("3"));

    // The reply should NOT have been delivered as a normal turn.
    expect(deliveries).toHaveLength(0);

    // The reply should NOT have produced a channel-side response message
    // (no reprompt, no error).
    expect(replies).toHaveLength(0);

    // The approval response handler should have been called exactly once.
    expect(approvalResponses).toHaveLength(1);

    // Verify the runtime scope propagated correctly.
    expect(approvalResponses[0]?.runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "conv-1",
    });

    // Verify the response is an allow decision with updated_input containing
    // the original questions and the parsed answer.
    const response = approvalResponses[0]?.response as {
      request_id: string;
      decision: {
        behavior: string;
        updated_input?: {
          action?: string;
          channel?: string;
          chat_id?: string;
          questions?: unknown[];
          answers?: Record<string, string>;
        };
      };
    };

    expect(response.request_id).toBe(event.requestId);
    expect(response.decision.behavior).toBe("allow");

    // The updated_input should preserve the original MessageChannel args.
    const updatedInput = response.decision.updated_input;
    expect(updatedInput).toBeDefined();
    expect(updatedInput?.action).toBe("ask");
    expect(updatedInput?.channel).toBe("slack");
    expect(updatedInput?.chat_id).toBe("C789");
    expect(updatedInput?.questions).toEqual([
      {
        question: QUESTION_TEXT,
        header: QUESTION_HEADER,
        options: OPTIONS,
        multiSelect: false,
      },
    ]);

    // The answer should be mapped from "3" to "Canary".
    expect(updatedInput?.answers).toEqual({
      [QUESTION_TEXT]: "Canary",
    });

    // The pending request should have been cleared after handling.
    expect(registry.hasPendingControlRequest(event.requestId)).toBe(false);
  });

  test("freeform channel reply resolves MessageChannel ask with passthrough answer", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    registry.setMessageHandler(() => {});
    registry.setApprovalResponseHandler(async () => true);

    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C789",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });

    await registry.registerPendingControlRequest(
      createMessageChannelAskEvent(),
    );

    const approvalResponses: Array<{ response: unknown }> = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push({ response: params.response });
      return true;
    });

    // Send a freeform reply that doesn't match any option number.
    await adapter.onMessage?.(
      createInboundReply("let's go with rolling update"),
    );

    expect(approvalResponses).toHaveLength(1);

    const response = approvalResponses[0]?.response as {
      decision: {
        behavior: string;
        updated_input?: { answers?: Record<string, string> };
      };
    };

    expect(response.decision.behavior).toBe("allow");
    expect(response.decision.updated_input?.answers).toEqual({
      [QUESTION_TEXT]: "let's go with rolling update",
    });
  });

  test("updated_input answers propagate to the approval response handler for multi-question asks", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    registry.setMessageHandler(() => {});

    const approvalResponses: Array<{ response: unknown }> = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push({ response: params.response });
      return true;
    });

    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C789",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });

    const multiQuestionInput = {
      action: "ask",
      channel: "slack",
      chat_id: "C789",
      questions: [
        {
          question: QUESTION_TEXT,
          header: QUESTION_HEADER,
          options: OPTIONS,
          multiSelect: false,
        },
        {
          question: "Which region should we deploy to?",
          header: "Region",
          options: [
            { label: "us-east-1", description: "Virginia" },
            { label: "eu-west-1", description: "Ireland" },
          ],
          multiSelect: false,
        },
      ],
    };

    await registry.registerPendingControlRequest({
      requestId: "perm-msg-ch-ask-multi",
      kind: "ask_user_question",
      source: {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C789",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      toolName: "MessageChannel",
      input: multiQuestionInput,
    });

    // Numbered reply: "1: 2" means first question → option 2 (Rolling),
    // "2: 1" means second question → option 1 (us-east-1).
    await adapter.onMessage?.(createInboundReply("1: 2\n2: 1"));

    expect(approvalResponses).toHaveLength(1);

    const response = approvalResponses[0]?.response as {
      decision: {
        behavior: string;
        updated_input?: { answers?: Record<string, string> };
      };
    };

    expect(response.decision.behavior).toBe("allow");
    expect(response.decision.updated_input?.answers).toEqual({
      [QUESTION_TEXT]: "Rolling",
      "Which region should we deploy to?": "us-east-1",
    });
  });
});
