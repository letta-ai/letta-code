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
import { __testOverrideChannelsRoot, readChannelConfig } from "./config";
import type {
  ChannelAccount,
  WhatsAppChannelAccount,
  WhatsAppChannelConfig,
} from "./types";

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
          message_prefix: "[bot] ",
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
    expect(created.messagePrefix).toBe("[bot] ");

    const updated = updateChannelAccountLive("whatsapp", "personal", {
      config: { group_mode: "open", self_chat_mode: true },
    });
    expect(updated.groupMode).toBe("open");
    expect(updated.selfChatMode).toBe(true);
    expect(updated.messagePrefix).toBe("[bot] ");
    expect(updated.config).toEqual(
      expect.objectContaining({ message_prefix: "[bot] " }),
    );

    const cleared = updateChannelAccountLive("whatsapp", "personal", {
      config: { message_prefix: "" },
    });
    expect(cleared.messagePrefix).toBe("");
  });

  test("migrates snake_case message prefix and saves the canonical key", () => {
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
        message_prefix: "[bot] ",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      } as unknown as ChannelAccount,
    ]);
    __testOverrideSaveChannelAccounts((_channelId, accounts) => {
      persisted = accounts[0] as unknown as Record<string, unknown>;
    });

    loadChannelAccounts("whatsapp");
    const loaded = getChannelAccount("whatsapp", "personal");
    expect((loaded as WhatsAppChannelAccount | null)?.messagePrefix).toBe(
      "[bot] ",
    );
    if (!loaded) throw new Error("migrated account was not loaded");

    upsertChannelAccount("whatsapp", loaded);
    expect(persisted?.message_prefix).toBe("[bot] ");
    expect(persisted).not.toHaveProperty("messagePrefix");
  });

  test("migrates message prefix from legacy YAML", () => {
    const root = mkdtempSync(join(tmpdir(), "whatsapp-prefix-"));
    try {
      mkdirSync(join(root, "whatsapp"), { recursive: true });
      writeFileSync(
        join(root, "whatsapp", "config.yaml"),
        [
          "enabled: true",
          "dm_policy: pairing",
          "message_prefix: '[bot] '",
          "",
        ].join("\n"),
      );
      __testOverrideChannelsRoot(root);
      __testOverrideLoadChannelAccounts(null);

      expect(
        (readChannelConfig("whatsapp") as WhatsAppChannelConfig | null)
          ?.messagePrefix,
      ).toBe("[bot] ");
      loadChannelAccounts("whatsapp");
      expect(
        (
          getChannelAccount(
            "whatsapp",
            "__legacy_migrated__",
          ) as WhatsAppChannelAccount | null
        )?.messagePrefix,
      ).toBe("[bot] ");
    } finally {
      __testOverrideChannelsRoot(null);
      rmSync(root, { recursive: true, force: true });
    }
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
