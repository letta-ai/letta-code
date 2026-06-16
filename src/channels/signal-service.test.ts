import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
} from "@/channels/routing";
import {
  bindChannelAccountLive,
  createChannelAccountLive,
  getChannelConfigSnapshot,
  updateChannelAccountLive,
} from "@/channels/service";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";

describe("Signal channel service", () => {
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
  });

  test("creates conservative defaults", () => {
    const created = createChannelAccountLive(
      "signal",
      { enabled: false },
      { accountId: "personal" },
    );

    expect(created).toEqual(
      expect.objectContaining({
        channelId: "signal",
        accountId: "personal",
        configured: false,
        groupMode: "disabled",
        dmPolicy: "pairing",
        agentId: null,
      }),
    );
    expect(created.config).toEqual(
      expect.objectContaining({
        base_url: "",
        agent_id: null,
        group_mode: "disabled",
      }),
    );
  });

  test("normalizes plugin config from snake_case", () => {
    const created = createChannelAccountLive(
      "signal",
      {
        enabled: true,
        dmPolicy: "open",
        config: {
          base_url: "http://signal.local:8080",
          account: "+15555550100",
          account_uuid: "self-uuid",
          agent_id: "agent-signal",
          group_mode: "mention",
          allowed_groups: ["group-1"],
          mention_patterns: ["letta"],
          download_media: true,
          media_max_bytes: 1048576,
        },
      },
      { accountId: "personal" },
    );

    expect(created.agentId).toBe("agent-signal");
    expect(created.config).toEqual(
      expect.objectContaining({
        base_url: "http://signal.local:8080",
        account: "+15555550100",
        account_uuid: "self-uuid",
      }),
    );
    expect(created.groupMode).toBe("mention");
    expect(created.allowedGroups).toEqual(["group-1"]);
    expect(created.mentionPatterns).toEqual(["letta"]);
    expect(created.downloadMedia).toBe(true);
    expect(created.mediaMaxBytes).toBe(1048576);

    const updated = updateChannelAccountLive("signal", "personal", {
      config: { group_mode: "open", account: null },
    });
    expect(updated.groupMode).toBe("open");
    expect(updated.config).toEqual(
      expect.objectContaining({ account: undefined }),
    );
  });

  test("bind updates the account-level agent id", () => {
    createChannelAccountLive("signal", {}, { accountId: "personal" });
    const bound = bindChannelAccountLive(
      "signal",
      "personal",
      "agent-bound",
      "conv-ignored",
    );
    expect(bound.agentId).toBe("agent-bound");

    expect(getChannelConfigSnapshot("signal", "personal")).toEqual(
      expect.objectContaining({
        agentId: "agent-bound",
        config: expect.objectContaining({ agent_id: "agent-bound" }),
      }),
    );
  });
});
