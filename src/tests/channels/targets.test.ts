import { afterEach, describe, expect, test } from "bun:test";
import {
  clearTargetStores,
  getChannelTarget,
  listChannelTargets,
  upsertChannelTarget,
} from "../../channels/targets";

describe("channel targets", () => {
  afterEach(() => {
    clearTargetStores();
  });

  test("upserts a discovered channel target", () => {
    upsertChannelTarget("slack", {
      targetId: "C123",
      targetType: "channel",
      chatId: "C123",
      label: "#eng",
      discoveredAt: "2026-04-10T00:00:00.000Z",
      lastSeenAt: "2026-04-10T00:00:00.000Z",
      lastMessageId: "1712700000.000100",
    });

    expect(listChannelTargets("slack")).toHaveLength(1);
    expect(getChannelTarget("slack", "C123")?.label).toBe("#eng");
  });

  test("preserves discoveredAt when a target is rediscovered", () => {
    upsertChannelTarget("slack", {
      targetId: "C123",
      targetType: "channel",
      chatId: "C123",
      label: "#eng",
      discoveredAt: "2026-04-10T00:00:00.000Z",
      lastSeenAt: "2026-04-10T00:00:00.000Z",
    });

    const updated = upsertChannelTarget("slack", {
      targetId: "C123",
      targetType: "channel",
      chatId: "C123",
      label: "#eng-updated",
      discoveredAt: "2026-04-10T01:00:00.000Z",
      lastSeenAt: "2026-04-10T01:00:00.000Z",
      lastMessageId: "1712703600.000200",
    });

    expect(updated.discoveredAt).toBe("2026-04-10T00:00:00.000Z");
    expect(updated.lastSeenAt).toBe("2026-04-10T01:00:00.000Z");
    expect(updated.lastMessageId).toBe("1712703600.000200");
  });
});
