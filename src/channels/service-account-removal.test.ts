import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __setActiveChannelCredentialsStoreModeForTests,
  __setChannelSecretStoreOverrideForTests,
  buildChannelSecretName,
} from "@/channels/credential-store";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
  consumePairingCode,
  createPairingCode,
  getApprovedUsers,
  getPendingPairings,
} from "@/channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import {
  createChannelAccountLiveWithSecrets,
  getChannelAccountSnapshot,
  removeChannelAccountLive,
} from "@/channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
  getChannelTarget,
  upsertChannelTarget,
} from "@/channels/targets";

describe("channel account removal", () => {
  beforeEach(() => {
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});
    __setActiveChannelCredentialsStoreModeForTests("keyring");
  });

  afterEach(() => {
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
    __setActiveChannelCredentialsStoreModeForTests(null);
    __setChannelSecretStoreOverrideForTests(null);
  });

  test("removes local account state before reporting keyring cleanup failures", async () => {
    const secrets = new Map<string, string>();
    const deleteCalls: string[] = [];
    const localStateRemovedBeforeSecretCleanup: boolean[] = [];
    let secretReadCount = 0;
    const accountId = "slack-app";
    const channelId = "slack";
    const chatId = "C-account";
    const targetId = "target-C-account";
    const botSecretName = buildChannelSecretName(
      channelId,
      accountId,
      "botToken",
    );
    const appSecretName = buildChannelSecretName(
      channelId,
      accountId,
      "appToken",
    );

    __setChannelSecretStoreOverrideForTests({
      get: async (name) => {
        secretReadCount++;
        return secrets.get(name) ?? null;
      },
      set: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => {
        deleteCalls.push(name);
        localStateRemovedBeforeSecretCleanup.push(
          getChannelAccountSnapshot(channelId, accountId) === null &&
            getRoute(channelId, chatId, accountId, null) === null &&
            getChannelTarget(channelId, targetId, accountId) === null &&
            getPendingPairings(channelId, accountId).length === 0 &&
            getApprovedUsers(channelId, accountId).length === 0,
        );
        throw new Error("keyring delete failed");
      },
    });

    await createChannelAccountLiveWithSecrets(
      channelId,
      {
        enabled: false,
        botToken: "xoxb-token",
        appToken: "xapp-token",
        dmPolicy: "pairing",
      },
      { accountId },
    );
    addRoute(channelId, {
      accountId,
      chatId,
      chatType: "channel",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });
    upsertChannelTarget(channelId, {
      accountId,
      targetId,
      targetType: "channel",
      chatId,
      label: "#account",
      discoveredAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:00:00.000Z",
      lastMessageId: "1712790000.000100",
    });
    createPairingCode(
      channelId,
      "U-pending",
      chatId,
      "Pending User",
      accountId,
    );
    const approvedCode = createPairingCode(
      channelId,
      "U-approved",
      chatId,
      "Approved User",
      accountId,
    );
    expect(
      consumePairingCode(channelId, approvedCode, accountId),
    ).not.toBeNull();

    expect(getChannelAccountSnapshot(channelId, accountId)).not.toBeNull();
    expect(getRoute(channelId, chatId, accountId, null)).not.toBeNull();
    expect(getChannelTarget(channelId, targetId, accountId)).not.toBeNull();
    expect(getPendingPairings(channelId, accountId)).toHaveLength(1);
    expect(getApprovedUsers(channelId, accountId)).toHaveLength(1);
    expect(secrets.get(botSecretName)).toBe("xoxb-token");
    expect(secrets.get(appSecretName)).toBe("xapp-token");

    await expect(
      removeChannelAccountLive(channelId, accountId),
    ).rejects.toThrow("keyring delete failed");

    expect(secretReadCount).toBe(0);
    expect([...deleteCalls].sort()).toEqual(
      [appSecretName, botSecretName].sort(),
    );
    expect(localStateRemovedBeforeSecretCleanup).toEqual([true, true]);
    expect(getChannelAccountSnapshot(channelId, accountId)).toBeNull();
    expect(getRoute(channelId, chatId, accountId, null)).toBeNull();
    expect(getChannelTarget(channelId, targetId, accountId)).toBeNull();
    expect(getPendingPairings(channelId, accountId)).toEqual([]);
    expect(getApprovedUsers(channelId, accountId)).toEqual([]);
    expect(secrets.get(botSecretName)).toBe("xoxb-token");
    expect(secrets.get(appSecretName)).toBe("xapp-token");
  });
});
