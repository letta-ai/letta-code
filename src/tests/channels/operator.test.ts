import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testClearOperatorDestinationStore,
  __testOverrideOperatorDestinationStore,
  listOperatorDestinations,
  type OperatorDestination,
  removeOperatorDestination,
  resolveOperatorDestination,
  upsertOperatorDestination,
} from "../../channels/operator";

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

  afterEach(() => {
    __testClearOperatorDestinationStore();
    __testOverrideOperatorDestinationStore(null);
  });

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
