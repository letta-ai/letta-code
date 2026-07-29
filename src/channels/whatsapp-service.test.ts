import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  getChannelAccount,
  loadChannelAccounts,
  upsertChannelAccount,
} from "@/channels/accounts";
import {
  __testOverrideChannelsRoot,
  readChannelConfig,
} from "@/channels/config";
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
import {
  type ChannelAccount,
  isWhatsAppChannelAccount,
  type WhatsAppChannelAccount,
  type WhatsAppChannelConfig,
} from "@/channels/types";

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
    __testOverrideChannelsRoot(null);
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
        waiting_behavior: "off",
      }),
    );
  });

  test("normalizes all WhatsApp plugin fields and supports updates", () => {
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
          attachment_filter: true,
          attachment_mime_types: ["image/png", "audio/mpeg"],
          attachment_allowed_recipients: ["15551234567"],
          attachment_allowed_paths: ["/tmp/uploads"],
          attachment_path_recursive: true,
          inbound_debounce_ms: 1250.9,
          waiting_behavior: "typing_indicator",
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
    expect(created.attachmentFilter).toBe(true);
    expect(created.attachmentMimeTypes).toEqual(["image/png", "audio/mpeg"]);
    expect(created.attachmentAllowedRecipients).toEqual(["15551234567"]);
    expect(created.attachmentAllowedPaths).toEqual(["/tmp/uploads"]);
    expect(created.attachmentPathRecursive).toBe(true);
    expect(created.inboundDebounceMs).toBe(1250);
    expect(created.waitingBehavior).toBe("typing_indicator");

    const updated = updateChannelAccountLive("whatsapp", "personal", {
      config: {
        group_mode: "open",
        self_chat_mode: true,
        attachment_filter: false,
        attachment_mime_types: ["application/pdf"],
        attachment_allowed_recipients: ["120363@g.us"],
        attachment_allowed_paths: ["/tmp/docs"],
        attachment_path_recursive: false,
      },
    });
    expect(updated.groupMode).toBe("open");
    expect(updated.selfChatMode).toBe(true);
    expect(updated.attachmentFilter).toBe(false);
    expect(updated.inboundDebounceMs).toBe(1250);
    expect(updated.waitingBehavior).toBe("typing_indicator");
    expect(updated.config).toEqual(
      expect.objectContaining({
        attachment_filter: false,
        attachment_mime_types: ["application/pdf"],
        attachment_allowed_recipients: ["120363@g.us"],
        attachment_allowed_paths: ["/tmp/docs"],
        attachment_path_recursive: false,
        inbound_debounce_ms: 1250,
        waiting_behavior: "typing_indicator",
      }),
    );
    const disabled = updateChannelAccountLive("whatsapp", "personal", {
      config: { waiting_behavior: "off" },
    });
    expect(disabled.waitingBehavior).toBe("off");
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

  test("loads and saves attachment policy fields from accounts.json snake_case", () => {
    const saved: ChannelAccount[] = [];
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "whatsapp",
        accountId: "disk-account",
        enabled: true,
        dmPolicy: "open",
        allowedUsers: [],
        agentId: null,
        selfChatMode: true,
        groupMode: "disabled",
        attachment_filter: true,
        attachment_mime_types: ["image/png"],
        attachment_allowed_recipients: ["15551234567"],
        attachment_allowed_paths: ["/tmp/uploads"],
        attachment_path_recursive: true,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      } as unknown as ChannelAccount,
    ]);
    __testOverrideSaveChannelAccounts((_channelId, accounts) =>
      saved.push(...accounts),
    );
    const loaded = getChannelAccount("whatsapp", "disk-account");
    if (!loaded || !isWhatsAppChannelAccount(loaded))
      throw new Error("Expected a loaded WhatsApp account");
    expect(loaded.attachmentFilter).toBe(true);
    expect(loaded.attachmentMimeTypes).toEqual(["image/png"]);
    expect(loaded.attachmentAllowedRecipients).toEqual(["15551234567"]);
    expect(loaded.attachmentAllowedPaths).toEqual(["/tmp/uploads"]);
    expect(loaded.attachmentPathRecursive).toBe(true);
    upsertChannelAccount("whatsapp", loaded);
    const stored = saved[0] as unknown as Record<string, unknown>;
    expect(stored.attachment_filter).toBe(true);
    expect(stored.attachment_mime_types).toEqual(["image/png"]);
    expect(stored.attachment_allowed_recipients).toEqual(["15551234567"]);
    expect(stored.attachment_allowed_paths).toEqual(["/tmp/uploads"]);
    expect(stored.attachment_path_recursive).toBe(true);
    expect(stored.attachmentFilter).toBeUndefined();
  });

  test("migrates snake_case accounts and saves debounce/waiting keys", () => {
    let persisted: Record<string, unknown> | undefined;
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "whatsapp",
        accountId: "personal",
        enabled: true,
        dmPolicy: "pairing",
        allowedUsers: [],
        agentId: null,
        selfChatMode: true,
        groupMode: "disabled",
        inbound_debounce_ms: 1250.9,
        waiting_behavior: "typing_indicator",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      } as never,
    ]);
    __testOverrideSaveChannelAccounts((_channelId, accounts) => {
      persisted = accounts[0] as unknown as Record<string, unknown>;
    });
    loadChannelAccounts("whatsapp");
    const loaded = getChannelAccount("whatsapp", "personal");
    expect((loaded as WhatsAppChannelAccount | null)?.inboundDebounceMs).toBe(
      1250,
    );
    expect((loaded as WhatsAppChannelAccount | null)?.waitingBehavior).toBe(
      "typing_indicator",
    );
    if (!loaded) throw new Error("migrated account was not loaded");
    upsertChannelAccount("whatsapp", loaded);
    expect(persisted?.inbound_debounce_ms).toBe(1250);
    expect(persisted?.waiting_behavior).toBe("typing_indicator");
    expect(persisted).not.toHaveProperty("inboundDebounceMs");
    expect(persisted).not.toHaveProperty("waitingBehavior");
  });

  test("migrates fractional debounce from legacy YAML", () => {
    const root = mkdtempSync(join(tmpdir(), "whatsapp-config-"));
    try {
      mkdirSync(join(root, "whatsapp"), { recursive: true });
      writeFileSync(
        join(root, "whatsapp", "config.yaml"),
        [
          "enabled: true",
          "dm_policy: pairing",
          "agent_id: agent-whatsapp",
          "inbound_debounce_ms: 875.9",
          "",
        ].join("\n"),
      );
      __testOverrideChannelsRoot(root);
      __testOverrideLoadChannelAccounts(null);
      expect(
        (readChannelConfig("whatsapp") as WhatsAppChannelConfig | null)
          ?.inboundDebounceMs,
      ).toBe(875);
      loadChannelAccounts("whatsapp");
      expect(
        (
          getChannelAccount(
            "whatsapp",
            "__legacy_migrated__",
          ) as WhatsAppChannelAccount | null
        )?.inboundDebounceMs,
      ).toBe(875);
    } finally {
      __testOverrideChannelsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrates waiting behavior from legacy YAML with safe cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "whatsapp-waiting-"));
    try {
      mkdirSync(join(root, "whatsapp"), { recursive: true });
      writeFileSync(
        join(root, "whatsapp", "config.yaml"),
        [
          "enabled: true",
          "dm_policy: pairing",
          "waiting_behavior: typing_indicator",
          "",
        ].join("\n"),
      );
      __testOverrideChannelsRoot(root);
      __testOverrideLoadChannelAccounts(null);
      expect(
        (readChannelConfig("whatsapp") as WhatsAppChannelConfig | null)
          ?.waitingBehavior,
      ).toBe("typing_indicator");
      loadChannelAccounts("whatsapp");
      expect(
        (
          getChannelAccount(
            "whatsapp",
            "__legacy_migrated__",
          ) as WhatsAppChannelAccount | null
        )?.waitingBehavior,
      ).toBe("typing_indicator");
    } finally {
      __testOverrideChannelsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
