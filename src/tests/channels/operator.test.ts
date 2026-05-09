import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  upsertChannelAccount,
} from "../../channels/accounts";
import {
  __testClearOperatorDestinationStore,
  __testOverrideOperatorDestinationStore,
  listOperatorDestinations,
  type OperatorDestination,
  removeOperatorDestination,
  resolveOperatorDestination,
  sendOperatorMessage,
  upsertOperatorDestination,
} from "../../channels/operator";
import { ChannelRegistry, getChannelRegistry } from "../../channels/registry";
import type { ChannelAdapter } from "../../channels/types";

describe("operator destinations", () => {
  let saved: OperatorDestination[] = [];

  beforeEach(() => {
    saved = [];
    __testOverrideOperatorDestinationStore(
      () => saved,
      (destinations) => {
        saved = destinations;
      },
    );
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    __testClearOperatorDestinationStore();
    __testOverrideOperatorDestinationStore(null);
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  function installChannelAccountOverrides(): void {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
  }

  function upsertSlackOperatorAccount(): void {
    installChannelAccountOverrides();
    upsertChannelAccount("slack", {
      channel: "slack",
      accountId: "operator-account",
      displayName: "Operator Slack",
      enabled: true,
      mode: "socket",
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      dmPolicy: "pairing",
      allowedUsers: [],
      agentId: "agent-1",
      defaultPermissionMode: "default",
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });
  }

  function upsertSlackOperatorDestination(): void {
    upsertOperatorDestination({
      agentId: "agent-1",
      conversationId: "conv-1",
      channel: "slack",
      accountId: "operator-account",
      chatId: "COPS",
      threadId: "1712800000.000200",
    });
  }

  function registerSlackOperatorAdapter(params?: {
    running?: boolean;
    messageId?: string;
  }): ReturnType<typeof mock> {
    const registry = new ChannelRegistry();
    const sendMessage = mock(async () => ({
      messageId: params?.messageId ?? "operator-msg-1",
    }));
    const adapter: ChannelAdapter = {
      id: "slack:operator-account",
      channelId: "slack",
      accountId: "operator-account",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => params?.running ?? true,
      sendMessage,
      sendDirectReply: async () => {},
    };
    registry.registerAdapter(adapter);
    return sendMessage;
  }

  test("upserts and lists operator destinations", () => {
    const destination = upsertOperatorDestination({
      agentId: "agent-1",
      channel: "telegram",
      accountId: "telegram-account",
      chatId: "515978553",
    });

    expect(destination.enabled).toBe(true);
    expect(destination.notifyOnErrors).toBe(true);
    expect(destination.notifyOnRetries).toBe(false);
    expect(destination.useAsMessageChannelDefault).toBe(true);
    expect(listOperatorDestinations("agent-1")).toHaveLength(1);
    expect(saved[0]?.chatId).toBe("515978553");
  });

  test("conversation-specific destination wins over agent default", () => {
    upsertOperatorDestination({
      agentId: "agent-1",
      channel: "telegram",
      accountId: "telegram-account",
      chatId: "default-chat",
    });
    upsertOperatorDestination({
      agentId: "agent-1",
      conversationId: "conv-1",
      channel: "slack",
      accountId: "slack-account",
      chatId: "COPS",
    });

    expect(
      resolveOperatorDestination({
        agentId: "agent-1",
        conversationId: "conv-1",
      })?.chatId,
    ).toBe("COPS");
    expect(
      resolveOperatorDestination({
        agentId: "agent-1",
        conversationId: "conv-2",
      })?.chatId,
    ).toBe("default-chat");
  });

  test("upsert replaces existing agent/conversation scope when id is omitted", () => {
    const first = upsertOperatorDestination({
      agentId: "agent-1",
      channel: "telegram",
      accountId: "telegram-account",
      chatId: "old-chat",
    });
    const second = upsertOperatorDestination({
      agentId: "agent-1",
      channel: "slack",
      accountId: "slack-account",
      chatId: "new-chat",
    });

    expect(second.id).toBe(first.id);
    expect(listOperatorDestinations("agent-1")).toHaveLength(1);
    expect(resolveOperatorDestination({ agentId: "agent-1" })?.chatId).toBe(
      "new-chat",
    );
  });

  test("honors destination flags", () => {
    upsertOperatorDestination({
      agentId: "agent-1",
      channel: "telegram",
      accountId: "telegram-account",
      chatId: "default-chat",
      notifyOnErrors: false,
      useAsMessageChannelDefault: false,
    });

    expect(
      resolveOperatorDestination({
        agentId: "agent-1",
        requireErrorNotifications: true,
      }),
    ).toBeNull();
    expect(
      resolveOperatorDestination({
        agentId: "agent-1",
        requireMessageChannelDefault: true,
      }),
    ).toBeNull();
  });

  test("sendOperatorMessage reports missing channel account", async () => {
    installChannelAccountOverrides();
    upsertSlackOperatorDestination();

    const result = await sendOperatorMessage({
      agentId: "agent-1",
      conversationId: "conv-1",
      message: "operator ping",
    });

    expect(result).toEqual({
      delivered: false,
      reason: "Operator channel account not found",
    });
  });

  test("sendOperatorMessage reports when the adapter is not running", async () => {
    upsertSlackOperatorAccount();
    upsertSlackOperatorDestination();
    const sendMessage = registerSlackOperatorAdapter({ running: false });

    const result = await sendOperatorMessage({
      agentId: "agent-1",
      conversationId: "conv-1",
      message: "operator ping",
    });

    expect(result).toEqual({
      delivered: false,
      reason: "Operator channel is not running",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("sendOperatorMessage dispatches through plugin message actions", async () => {
    upsertSlackOperatorAccount();
    upsertSlackOperatorDestination();
    const sendMessage = registerSlackOperatorAdapter({
      messageId: "slack-msg-1",
    });

    const result = await sendOperatorMessage({
      agentId: "agent-1",
      conversationId: "conv-1",
      message: "operator ping",
    });

    expect(result).toEqual({ delivered: true, messageId: "slack-msg-1" });
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "operator-account",
      chatId: "COPS",
      text: "operator ping",
      replyToMessageId: undefined,
      threadId: "1712800000.000200",
      mediaPath: undefined,
      fileName: undefined,
      title: undefined,
      parseMode: undefined,
    });
  });

  test("sendOperatorMessage dedupes repeated notifications", async () => {
    upsertSlackOperatorAccount();
    upsertSlackOperatorDestination();
    const sendMessage = registerSlackOperatorAdapter();

    const first = await sendOperatorMessage({
      agentId: "agent-1",
      conversationId: "conv-1",
      message: "operator ping",
      dedupeKey: "run-1:error",
    });
    const second = await sendOperatorMessage({
      agentId: "agent-1",
      conversationId: "conv-1",
      message: "operator ping",
      dedupeKey: "run-1:error",
    });

    expect(first).toEqual({ delivered: true, messageId: "operator-msg-1" });
    expect(second).toEqual({
      delivered: false,
      reason: "Duplicate operator notification",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("removes destinations by id", () => {
    const destination = upsertOperatorDestination({
      agentId: "agent-1",
      channel: "telegram",
      accountId: "telegram-account",
      chatId: "515978553",
    });

    expect(removeOperatorDestination(destination.id)).toBe(true);
    expect(listOperatorDestinations("agent-1")).toHaveLength(0);
    expect(removeOperatorDestination(destination.id)).toBe(false);
  });
});
