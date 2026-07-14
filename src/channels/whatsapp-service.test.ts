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

describe("WhatsApp channel service", () => {
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
      "whatsapp",
      { enabled: false },
      { accountId: "personal" },
    );

    expect(created).toEqual(
      expect.objectContaining({
        channelId: "whatsapp",
        accountId: "personal",
        configured: true,
        selfChatMode: true,
        groupMode: "disabled",
        dmPolicy: "pairing",
        agentId: null,
      }),
    );
    expect(created.config).toEqual(
      expect.objectContaining({
        self_chat_mode: true,
        group_mode: "disabled",
        agent_id: null,
      }),
    );
  });

  test("normalizes plugin config from snake_case", () => {
    const created = createChannelAccountLive(
      "whatsapp",
      {
        enabled: true,
        dmPolicy: "open",
        config: {
          agent_id: "agent-whatsapp",
          self_chat_mode: false,
          group_mode: "mention",
          allowed_groups: ["120363@g.us"],
          mention_patterns: ["\\bloop\\b"],
          download_media: true,
          media_max_bytes: 1048576,
        },
      },
      { accountId: "personal" },
    );

    expect(created.agentId).toBe("agent-whatsapp");
    expect(created.selfChatMode).toBe(false);
    expect(created.groupMode).toBe("mention");
    expect(created.allowedGroups).toEqual(["120363@g.us"]);
    expect(created.mentionPatterns).toEqual(["\\bloop\\b"]);
    expect(created.downloadMedia).toBe(true);
    expect(created.mediaMaxBytes).toBe(1048576);

    const updated = updateChannelAccountLive("whatsapp", "personal", {
      config: { group_mode: "open", self_chat_mode: true },
    });
    expect(updated.groupMode).toBe("open");
    expect(updated.selfChatMode).toBe(true);
  });

  test("bind updates the account-level agent id", async () => {
    createChannelAccountLive("whatsapp", {}, { accountId: "personal" });
    const bound = await bindChannelAccountLive(
      "whatsapp",
      "personal",
      "agent-bound",
      "conv-ignored",
    );
    expect(bound.agentId).toBe("agent-bound");

    expect(getChannelConfigSnapshot("whatsapp", "personal")).toEqual(
      expect.objectContaining({
        agentId: "agent-bound",
        config: expect.objectContaining({ agent_id: "agent-bound" }),
      }),
    );
  });
});
