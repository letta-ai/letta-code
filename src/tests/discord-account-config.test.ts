import { describe, expect, test } from "bun:test";

import { discordAccountConfigAdapter } from "../channels/discord/accountConfig";

describe("discordAccountConfigAdapter", () => {
  // ── isValidConfig ────────────────────────────────────────────────

  describe("isValidConfig", () => {
    test("accepts config with no new fields (backward compat)", () => {
      expect(
        discordAccountConfigAdapter.isValidConfig({
          token: "test.token.value",
          agent_id: "agent-123",
          allowed_channels: ["ch-1"],
        }),
      ).toBe(true);
    });

    test("accepts channel_policy: mention", () => {
      expect(
        discordAccountConfigAdapter.isValidConfig({
          token: "test.token.value",
          channel_policy: "mention",
        }),
      ).toBe(true);
    });

    test("accepts channel_policy: open", () => {
      expect(
        discordAccountConfigAdapter.isValidConfig({
          token: "test.token.value",
          channel_policy: "open",
        }),
      ).toBe(true);
    });

    test("rejects invalid channel_policy value", () => {
      expect(
        discordAccountConfigAdapter.isValidConfig({
          token: "test.token.value",
          channel_policy: "invalid",
        }),
      ).toBe(false);
    });

    test("accepts auto_thread_on_mention: true", () => {
      expect(
        discordAccountConfigAdapter.isValidConfig({
          token: "test.token.value",
          auto_thread_on_mention: true,
        }),
      ).toBe(true);
    });

    test("accepts auto_thread_on_mention: false", () => {
      expect(
        discordAccountConfigAdapter.isValidConfig({
          token: "test.token.value",
          auto_thread_on_mention: false,
        }),
      ).toBe(true);
    });

    test("rejects auto_thread_on_mention with non-boolean value", () => {
      expect(
        discordAccountConfigAdapter.isValidConfig({
          token: "test.token.value",
          auto_thread_on_mention: "yes",
        }),
      ).toBe(false);
    });

    test("rejects unknown keys", () => {
      expect(
        discordAccountConfigAdapter.isValidConfig({
          token: "test.token.value",
          unknown_field: "value",
        }),
      ).toBe(false);
    });
  });

  // ── toAccountPatch ───────────────────────────────────────────────

  describe("toAccountPatch", () => {
    test("maps channel_policy to channelPolicy", () => {
      const patch = discordAccountConfigAdapter.toAccountPatch({
        channel_policy: "open",
      });
      expect(patch.channelPolicy).toBe("open");
    });

    test("maps auto_thread_on_mention to autoThreadOnMention", () => {
      const patch = discordAccountConfigAdapter.toAccountPatch({
        auto_thread_on_mention: false,
      });
      expect(patch.autoThreadOnMention).toBe(false);
    });

    test("returns undefined for missing new fields", () => {
      const patch = discordAccountConfigAdapter.toAccountPatch({
        token: "test.token.value",
      });
      expect(patch.channelPolicy).toBeUndefined();
      expect(patch.autoThreadOnMention).toBeUndefined();
    });
  });

  // ── toAccountConfig ──────────────────────────────────────────────

  describe("toAccountConfig", () => {
    test("serializes channelPolicy with default 'mention'", () => {
      const config = discordAccountConfigAdapter.toAccountConfig({
        channel: "discord",
        accountId: "acc-1",
        enabled: true,
        token: "test.token.value",
        agentId: null,
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      expect(config.channel_policy).toBe("mention");
    });

    test("serializes explicit channelPolicy 'open'", () => {
      const config = discordAccountConfigAdapter.toAccountConfig({
        channel: "discord",
        accountId: "acc-1",
        enabled: true,
        token: "test.token.value",
        agentId: null,
        dmPolicy: "pairing",
        allowedUsers: [],
        channelPolicy: "open",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      expect(config.channel_policy).toBe("open");
    });

    test("serializes autoThreadOnMention with default true", () => {
      const config = discordAccountConfigAdapter.toAccountConfig({
        channel: "discord",
        accountId: "acc-1",
        enabled: true,
        token: "test.token.value",
        agentId: null,
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      expect(config.auto_thread_on_mention).toBe(true);
    });

    test("serializes explicit autoThreadOnMention false", () => {
      const config = discordAccountConfigAdapter.toAccountConfig({
        channel: "discord",
        accountId: "acc-1",
        enabled: true,
        token: "test.token.value",
        agentId: null,
        dmPolicy: "pairing",
        allowedUsers: [],
        autoThreadOnMention: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      expect(config.auto_thread_on_mention).toBe(false);
    });
  });
});
