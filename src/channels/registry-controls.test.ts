import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __testOverrideLoadChannelAccounts } from "@/channels/accounts";
import {
  __testOverrideLoadPendingControlRequestStore,
  __testOverrideSavePendingControlRequestStore,
  clearPendingControlRequestStore,
} from "@/channels/pending-control-requests";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import { addRoute } from "@/channels/routing";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  InboundChannelMessage,
} from "@/channels/types";

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

describe("pending channel control requests", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
  });

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

  function createInboundMessage(
    text: string,
    overrides: Partial<InboundChannelMessage> = {},
  ): InboundChannelMessage {
    return {
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
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

  test("accepted Slack route dispatches immediate queued lifecycle before delivery", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-1",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      },
    ]);
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    const lifecycleEvents: unknown[] = [];
    const order: string[] = [];
    const adapter = createAdapter([]);
    adapter.handleTurnLifecycleEvent = async (event) => {
      order.push("lifecycle");
      lifecycleEvents.push(event);
    };
    adapter.prepareInboundMessage = async (message) => {
      order.push("prepare");
      return message;
    };
    registry.registerAdapter(adapter);
    registry.setMessageHandler((delivery) => {
      order.push("deliver");
      delivered.push(delivery);
    });
    registry.setReady();
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    await adapter.onMessage?.(createInboundMessage("hello"));

    expect(lifecycleEvents).toEqual([
      {
        type: "queued",
        source: expect.objectContaining({
          channel: "slack",
          accountId: "acct-slack",
          chatId: "C123",
          threadId: "1712790000.000050",
          agentId: "agent-1",
          conversationId: "conv-1",
        }),
      },
    ]);
    expect(delivered).toHaveLength(1);
    expect(order).toEqual(["lifecycle", "prepare", "deliver"]);
  });

  test("unrouted Slack thread replies do not dispatch assistant status", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-1",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      },
    ]);
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    const lifecycleEvents: unknown[] = [];
    const adapter = createAdapter([]);
    adapter.handleTurnLifecycleEvent = async (event) => {
      lifecycleEvents.push(event);
    };
    registry.registerAdapter(adapter);
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage("unrelated thread", {
        messageId: "1712800000.999999",
        threadId: "1712790000.999999",
      }),
    );

    expect(lifecycleEvents).toEqual([]);
    expect(delivered).toEqual([]);
  });

  function createPendingControlRequestEvent(
    overrides: Partial<ChannelControlRequestEvent> = {},
  ): ChannelControlRequestEvent {
    return {
      requestId: "req-ask-1",
      kind: "ask_user_question",
      source: {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which approach should we use?",
            header: "Approach",
            options: [
              {
                label: "Fast path",
                description: "Ship the smallest safe patch",
              },
              {
                label: "Deep refactor",
                description: "Restructure the code more thoroughly",
              },
            ],
            multiSelect: false,
          },
        ],
      },
      ...overrides,
    };
  }

  test("channel replies resolve pending AskUserQuestion prompts instead of normal ingress", async () => {
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

    await registry.registerPendingControlRequest(
      createPendingControlRequestEvent(),
    );

    await adapter.onMessage?.(createInboundMessage("2"));

    expect(deliveries).toHaveLength(0);
    expect(replies).toHaveLength(0);
    expect(approvalResponses).toHaveLength(1);
    expect(approvalResponses[0]).toEqual({
      runtime: {
        agent_id: "agent-1",
        conversation_id: "conv-1",
      },
      response: {
        request_id: "req-ask-1",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: [
              {
                question: "Which approach should we use?",
                header: "Approach",
                options: [
                  {
                    label: "Fast path",
                    description: "Ship the smallest safe patch",
                  },
                  {
                    label: "Deep refactor",
                    description: "Restructure the code more thoroughly",
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              "Which approach should we use?": "Deep refactor",
            },
          },
        },
      },
    });
  });

  test("text control replies from other senders never resolve the prompt", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    const registry = new ChannelRegistry();
    const replies: Array<{ chatId: string; text: string }> = [];
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });

    const baseEvent = createPendingControlRequestEvent();
    await registry.registerPendingControlRequest({
      ...baseEvent,
      source: { ...baseEvent.source, senderId: "U123" },
    });

    // A different participant in the same chat/thread cannot answer the
    // prompt; their reply falls through to normal ingress handling.
    await adapter.onMessage?.(createInboundMessage("2", { senderId: "U999" }));
    expect(approvalResponses).toHaveLength(0);
    expect(deliveries).toHaveLength(0);

    // The initiating sender's reply still resolves the pending prompt.
    await adapter.onMessage?.(createInboundMessage("2"));
    expect(approvalResponses).toHaveLength(1);
    __testOverrideLoadChannelAccounts(null);
  });

  test("native approval controls resolve the exact request and enforce the initiating sender", async () => {
    const registry = new ChannelRegistry();
    const adapter = createAdapter([]);
    registry.registerAdapter(adapter);
    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    const baseEvent = createPendingControlRequestEvent();
    await registry.registerPendingControlRequest({
      ...baseEvent,
      kind: "generic_tool_approval",
      source: { ...baseEvent.source, senderId: "U123" },
      toolName: "Bash",
      input: { command: "bun test" },
    });

    const baseInput = {
      requestId: baseEvent.requestId,
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      threadId: "1712790000.000050",
      response: {
        request_id: baseEvent.requestId,
        decision: { behavior: "allow" as const },
      },
    };
    expect(
      await adapter.onControlResponse?.({
        ...baseInput,
        senderId: "U999",
      }),
    ).toBe("forbidden");
    expect(approvalResponses).toHaveLength(0);
    expect(registry.hasPendingControlRequest(baseEvent.requestId)).toBe(true);

    expect(
      await adapter.onControlResponse?.({
        ...baseInput,
        senderId: "U123",
      }),
    ).toBe("handled");
    expect(approvalResponses).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
        response: baseInput.response,
      },
    ]);
    expect(registry.hasPendingControlRequest(baseEvent.requestId)).toBe(false);
  });

  test("Slack thread text stays queued steering input while a native approval is pending", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-1",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "open",
        allowedUsers: [],
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
    ]);
    const registry = new ChannelRegistry();
    const adapter = createAdapter([]);
    registry.registerAdapter(adapter);
    const deliveries: unknown[] = [];
    const approvalResponses: unknown[] = [];
    registry.setMessageHandler((delivery) => deliveries.push(delivery));
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    registry.setReady();
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });
    const event = createPendingControlRequestEvent();
    await registry.registerPendingControlRequest({
      ...event,
      kind: "generic_tool_approval",
      toolName: "Bash",
      input: { command: "bun test" },
    });

    await adapter.onMessage?.(
      createInboundMessage("wait, do not run that yet"),
    );

    expect(approvalResponses).toHaveLength(0);
    expect(deliveries).toHaveLength(1);
    expect(registry.hasPendingControlRequest(event.requestId)).toBe(true);
  });

  test("/cancel bypasses pending channel control prompts", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);
    registry.setMessageHandler(() => {});

    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    const cancellations: unknown[] = [];
    registry.setCancelHandler(async (params) => {
      cancellations.push(params);
      return true;
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    await registry.registerPendingControlRequest(
      createPendingControlRequestEvent(),
    );

    await adapter.onMessage?.(createInboundMessage("/cancel"));

    expect(approvalResponses).toHaveLength(0);
    expect(cancellations).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "Slack cancelled the in-progress agent turn for this chat.",
        replyToMessageId: "1712800000.000200",
      },
    ]);
  });

  test("/reflection bypasses pending channel control prompts", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);
    registry.setMessageHandler(() => {});

    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    const reflections: unknown[] = [];
    registry.setReflectionHandler(async (params) => {
      reflections.push(params);
      return { handled: true, text: "Started a reflection pass." };
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    await registry.registerPendingControlRequest(
      createPendingControlRequestEvent(),
    );

    await adapter.onMessage?.(createInboundMessage("/reflection"));

    expect(approvalResponses).toHaveLength(0);
    expect(reflections).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "Started a reflection pass.",
        replyToMessageId: "1712800000.000200",
      },
    ]);
  });

  test("freeform multi-question channel replies approve instead of reprompting", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async ({ response }) => {
      approvalResponses.push(response);
      return true;
    });

    await registry.registerPendingControlRequest({
      requestId: "req-ask-2",
      kind: "ask_user_question",
      source: {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which approach should we use?",
            header: "Approach",
            options: [
              { label: "Fast path", description: "Ship quickly" },
              { label: "Deep refactor", description: "Refactor more" },
            ],
            multiSelect: false,
          },
          {
            question: "Which environment should we test in?",
            header: "Env",
            options: [
              { label: "Staging", description: "Safer rollout path" },
              { label: "Production", description: "Use the live environment" },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    await adapter.onMessage?.(createInboundMessage("deep refactor please"));

    expect(replies).toHaveLength(0);
    expect(approvalResponses).toEqual([
      {
        request_id: "req-ask-2",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: [
              {
                question: "Which approach should we use?",
                header: "Approach",
                options: [
                  { label: "Fast path", description: "Ship quickly" },
                  { label: "Deep refactor", description: "Refactor more" },
                ],
                multiSelect: false,
              },
              {
                question: "Which environment should we test in?",
                header: "Env",
                options: [
                  { label: "Staging", description: "Safer rollout path" },
                  {
                    label: "Production",
                    description: "Use the live environment",
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              "Which approach should we use?": "Deep refactor",
              "Which environment should we test in?":
                "Not specified. Full user reply: deep refactor please",
            },
          },
        },
      },
    ]);
  });

  test("bootstrapped persisted control requests intercept replies before the listener finishes reconnecting", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    __testOverrideLoadPendingControlRequestStore(() => ({
      requests: [createPendingControlRequestEvent()],
    }));

    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    await adapter.onMessage?.(createInboundMessage("approve"));

    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "I’m reconnecting to Letta Code right now, so I couldn’t use that reply yet. Please send it again in a moment.",
        replyToMessageId: "1712790000.000050",
      },
    ]);
  });

  test("clearing a bootstrapped control request also removes it from the persisted store", () => {
    const saveSnapshots: Array<{ requests: ChannelControlRequestEvent[] }> = [];
    __testOverrideLoadPendingControlRequestStore(() => ({
      requests: [createPendingControlRequestEvent()],
    }));
    __testOverrideSavePendingControlRequestStore((store) => {
      saveSnapshots.push({
        requests: store.requests,
      });
    });

    const registry = new ChannelRegistry();
    registry.clearPendingControlRequest("req-ask-1");

    expect(saveSnapshots.at(-1)).toEqual({ requests: [] });
  });
});
