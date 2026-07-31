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
          inbound_debounce_ms: 250.9,
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
    expect(created.inboundDebounceMs).toBe(250);
    expect(created.config).toEqual(
      expect.objectContaining({ inbound_debounce_ms: 250 }),
    );

    const clamped = updateChannelAccountLive("whatsapp", "personal", {
      config: { inbound_debounce_ms: 20_000 },
    });
    expect(clamped.inboundDebounceMs).toBe(10_000);

    const updated = updateChannelAccountLive("whatsapp", "personal", {
      config: { group_mode: "open", self_chat_mode: true },
    });
    expect(updated.groupMode).toBe("open");
    expect(updated.selfChatMode).toBe(true);
    expect(updated.inboundDebounceMs).toBe(10_000);
  });

  test("loads old WhatsApp accounts without debounce and accepts stored snake_case debounce", () => {
    const oldAccount = {
      channel: "whatsapp" as const,
      accountId: "old",
      enabled: true,
      dmPolicy: "pairing" as const,
      allowedUsers: [],
      agentId: null,
      selfChatMode: true,
      groupMode: "disabled" as const,
      allowedGroups: [],
      mentionPatterns: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const storedSnakeAccount = {
      channel: "whatsapp" as const,
      accountId: "snake",
      enabled: true,
      dmPolicy: "pairing" as const,
      allowedUsers: [],
      agentId: null,
      selfChatMode: true,
      groupMode: "disabled" as const,
      allowedGroups: [],
      mentionPatterns: [],
      inbound_debounce_ms: 999.8,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    __testOverrideLoadChannelAccounts(() => [oldAccount, storedSnakeAccount]);
    clearChannelAccountStores();

    expect(getChannelConfigSnapshot("whatsapp", "old")).toEqual(
      expect.objectContaining({
        inboundDebounceMs: undefined,
        config: expect.objectContaining({ inbound_debounce_ms: 0 }),
      }),
    );
    expect(getChannelConfigSnapshot("whatsapp", "snake")).toEqual(
      expect.objectContaining({
        inboundDebounceMs: 999,
        config: expect.objectContaining({ inbound_debounce_ms: 999 }),
      }),
    );
  });

  test("bind updates the account-level agent id", () => {
    createChannelAccountLive("whatsapp", {}, { accountId: "personal" });
    const bound = bindChannelAccountLive(
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
