import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearChannelAccountStores,
  flushPendingChannelSecretWrites,
  getChannelAccount,
} from "@/channels/accounts";
import {
  __testOverrideChannelsRoot,
  getChannelPairingPath,
  getChannelRoutingPath,
  getChannelTargetsPath,
} from "@/channels/config";
import {
  __setActiveChannelCredentialsStoreModeForTests,
  __setChannelSecretStoreOverrideForTests,
  buildChannelSecretName,
} from "@/channels/credential-store";
import {
  __testOverrideSavePairingStore,
  clearPairingStores,
  consumePairingCode,
  createPairingCode,
  getApprovedUsers,
  getPendingPairings,
} from "@/channels/pairing";
import { __testClearUserChannelPluginCache } from "@/channels/plugin-registry";
import { getChannelRegistry } from "@/channels/registry";
import {
  addRoute,
  clearAllRoutes,
  getRoutesForChannel,
} from "@/channels/routing";
import {
  createChannelAccountLiveWithSecrets,
  removeChannelAccountLive,
} from "@/channels/service";
import {
  __testOverrideSaveTargetStore,
  clearTargetStores,
  listChannelTargets,
  upsertChannelTarget,
} from "@/channels/targets";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("channel account delete cleanup transactions", () => {
  let channelsRoot: string;
  let secrets: Map<string, string>;

  beforeEach(() => {
    channelsRoot = mkdtempSync(join(tmpdir(), "letta-channel-delete-txn-"));
    secrets = new Map<string, string>();
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideChannelsRoot(channelsRoot);
    __testClearUserChannelPluginCache();
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    __setChannelSecretStoreOverrideForTests({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });
  });

  afterEach(async () => {
    await getChannelRegistry()?.stopAll();
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideChannelsRoot(null);
    __testClearUserChannelPluginCache();
    __setActiveChannelCredentialsStoreModeForTests(null);
    __setChannelSecretStoreOverrideForTests(null);
    __testOverrideSaveTargetStore(null);
    __testOverrideSavePairingStore(null);
    rmSync(channelsRoot, { recursive: true, force: true });
  });

  async function createSlackDeleteCleanupState() {
    await createChannelAccountLiveWithSecrets(
      "slack",
      {
        enabled: false,
        mode: "socket",
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
        dmPolicy: "pairing",
        agentId: "agent-1",
      },
      { accountId: "slack-account" },
    );
    await flushPendingChannelSecretWrites();

    const now = "2026-05-26T00:00:00.000Z";
    addRoute("slack", {
      accountId: "slack-account",
      chatId: "C-route",
      chatType: "channel",
      agentId: "agent-route",
      conversationId: "conv-route",
      enabled: true,
      outboundEnabled: true,
      detached: false,
      createdAt: now,
      updatedAt: now,
    });
    upsertChannelTarget("slack", {
      accountId: "slack-account",
      targetId: "target-1",
      targetType: "channel",
      chatId: "C-target",
      label: "target",
      discoveredAt: now,
      lastSeenAt: now,
    });
    createPairingCode(
      "slack",
      "U-pending",
      "D-pending",
      "Pending User",
      "slack-account",
    );
    const approvedCode = createPairingCode(
      "slack",
      "U-approved",
      "D-approved",
      "Approved User",
      "slack-account",
    );
    expect(consumePairingCode("slack", approvedCode, "slack-account")).not.toBe(
      null,
    );

    const botSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "botToken",
    );
    const appSecretName = buildChannelSecretName(
      "slack",
      "slack-account",
      "appToken",
    );

    return {
      botSecretName,
      appSecretName,
      routesPersisted: readJson(getChannelRoutingPath("slack")),
      targetsPersisted: readJson(getChannelTargetsPath("slack")),
      pairingPersisted: readJson(getChannelPairingPath("slack")),
      routes: getRoutesForChannel("slack", "slack-account"),
      targets: listChannelTargets("slack", "slack-account"),
      pending: getPendingPairings("slack", "slack-account"),
      approved: getApprovedUsers("slack", "slack-account"),
    };
  }

  function expectSlackDeleteCleanupStateIntact(
    before: Awaited<ReturnType<typeof createSlackDeleteCleanupState>>,
  ): void {
    const accounts = readJson(join(channelsRoot, "slack", "accounts.json")) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(accounts.accounts).toHaveLength(1);
    expect(getChannelAccount("slack", "slack-account")).toEqual(
      expect.objectContaining({
        botToken: "xoxb-secret",
        appToken: "xapp-secret",
      }),
    );
    expect(secrets.get(before.botSecretName)).toBe("xoxb-secret");
    expect(secrets.get(before.appSecretName)).toBe("xapp-secret");
    expect(readJson(getChannelRoutingPath("slack"))).toEqual(
      before.routesPersisted,
    );
    expect(readJson(getChannelTargetsPath("slack"))).toEqual(
      before.targetsPersisted,
    );
    expect(readJson(getChannelPairingPath("slack"))).toEqual(
      before.pairingPersisted,
    );
    expect(getRoutesForChannel("slack", "slack-account")).toEqual(
      before.routes,
    );
    expect(listChannelTargets("slack", "slack-account")).toEqual(
      before.targets,
    );
    expect(getPendingPairings("slack", "slack-account")).toEqual(
      before.pending,
    );
    expect(getApprovedUsers("slack", "slack-account")).toEqual(before.approved);
  }

  test("restores routes, targets, pairings, account, and secrets after target persistence failure", async () => {
    const before = await createSlackDeleteCleanupState();
    __testOverrideSaveTargetStore(() => {
      throw new Error("target cleanup failed");
    });

    await expect(
      removeChannelAccountLive("slack", "slack-account"),
    ).rejects.toThrow(/Account changes were rolled back/);

    expectSlackDeleteCleanupStateIntact(before);
  });

  test("restores routes, targets, pairings, account, and secrets after pairing persistence failure", async () => {
    const before = await createSlackDeleteCleanupState();
    __testOverrideSavePairingStore(() => {
      throw new Error("pairing cleanup failed");
    });

    await expect(
      removeChannelAccountLive("slack", "slack-account"),
    ).rejects.toThrow(/Account changes were rolled back/);

    expectSlackDeleteCleanupStateIntact(before);
  });
});
