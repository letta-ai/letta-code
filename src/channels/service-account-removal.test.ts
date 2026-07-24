import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __setActiveChannelCredentialsStoreModeForTests,
  __setChannelSecretStoreOverrideForTests,
} from "@/channels/credential-store";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import {
  createChannelAccountLive,
  getChannelAccountSnapshot,
  removeChannelAccountLive,
} from "@/channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
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

  test("preserves related state when keyring deletion fails", async () => {
    __setChannelSecretStoreOverrideForTests({
      get: async () => {
        throw new Error("Secret hydration should not run during deletion");
      },
      set: async () => {},
      delete: async () => {
        throw new Error("keyring delete failed");
      },
    });
    createChannelAccountLive(
      "telegram",
      {
        enabled: false,
        token: "telegram-token",
        dmPolicy: "pairing",
      },
      { accountId: "telegram-bot" },
    );
    addRoute("telegram", {
      accountId: "telegram-bot",
      chatId: "telegram-chat",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    await expect(
      removeChannelAccountLive("telegram", "telegram-bot"),
    ).rejects.toThrow("keyring delete failed");

    expect(
      getChannelAccountSnapshot("telegram", "telegram-bot"),
    ).not.toBeNull();
    expect(
      getRoute("telegram", "telegram-chat", "telegram-bot", null),
    ).not.toBeNull();
  });
});
