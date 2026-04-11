import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { clearPairingStores } from "../../channels/pairing";
import {
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRoute,
} from "../../channels/routing";
import {
  bindChannelTarget,
  listChannelTargetSnapshots,
} from "../../channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
  upsertChannelTarget,
} from "../../channels/targets";

describe("channel service", () => {
  function resetState(): void {
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideSaveRoutes(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
  }

  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    resetState();
  });

  test("bindChannelTarget rolls back the route and restores the target when route save fails", () => {
    const suffix = randomUUID();
    const targetId = `test-target-bind-rollback-${suffix}`;
    const chatId = `test-chat-bind-rollback-${suffix}`;
    const label = `#test-bind-rollback-${suffix}`;
    const savedTargetSnapshots: Array<
      Array<{ targetId: string; chatId: string; label: string }>
    > = [];

    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore((_channelId, store) => {
      savedTargetSnapshots.push(
        store.targets.map((target) => ({
          targetId: target.targetId,
          chatId: target.chatId,
          label: target.label,
        })),
      );
    });

    upsertChannelTarget("slack", {
      targetId,
      targetType: "channel",
      chatId,
      label,
      discoveredAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:00:00.000Z",
      lastMessageId: "1712790000.000100",
    });

    __testOverrideSaveRoutes(() => {
      throw new Error("ENOSPC: no space left");
    });

    expect(() =>
      bindChannelTarget("slack", targetId, "agent-test", "conv-test"),
    ).toThrow(/rolled back/i);

    expect(getRoute("slack", chatId)).toBeNull();
    expect(listChannelTargetSnapshots("slack")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "slack",
          targetId,
          chatId,
          label,
        }),
      ]),
    );
    expect(savedTargetSnapshots.at(-1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId,
          chatId,
          label,
        }),
      ]),
    );
  });
});
