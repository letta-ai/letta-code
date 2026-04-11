import { afterEach, describe, expect, test } from "bun:test";
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
  afterEach(() => {
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideSaveRoutes(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
  });

  test("bindChannelTarget rolls back the route and restores the target when route save fails", () => {
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});

    upsertChannelTarget("slack", {
      targetId: "test-target-bind-rollback",
      targetType: "channel",
      chatId: "test-chat-bind-rollback",
      label: "#test-bind-rollback",
      discoveredAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:00:00.000Z",
      lastMessageId: "1712790000.000100",
    });

    __testOverrideSaveRoutes(() => {
      throw new Error("ENOSPC: no space left");
    });

    expect(() =>
      bindChannelTarget(
        "slack",
        "test-target-bind-rollback",
        "agent-test",
        "conv-test",
      ),
    ).toThrow(/rolled back/i);

    expect(getRoute("slack", "test-chat-bind-rollback")).toBeNull();
    expect(listChannelTargetSnapshots("slack")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "slack",
          targetId: "test-target-bind-rollback",
          chatId: "test-chat-bind-rollback",
          label: "#test-bind-rollback",
        }),
      ]),
    );
  });
});
