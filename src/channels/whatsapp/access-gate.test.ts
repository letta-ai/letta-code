import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import type { WhatsAppChannelAccount } from "@/channels/types";
import {
  canDownloadWhatsAppMedia,
  evaluateWhatsAppGroupAccess,
  evaluateWhatsAppSenderAccess,
} from "./access-gate";
import {
  WHATSAPP_GROUP_SUFFIX,
  WHATSAPP_LID_SUFFIX,
  WHATSAPP_PHONE_SUFFIX,
} from "./jid";

const ACCOUNT_ID = "gate-test";
const SELF_PHONE = `15550000001${WHATSAPP_PHONE_SUFFIX}`;
const SELF_LID = `999000111${WHATSAPP_LID_SUFFIX}`;
const GROUP_JID = `120363000000000000${WHATSAPP_GROUP_SUFFIX}`;

function makeAccount(
  overrides: Partial<WhatsAppChannelAccount> = {},
): WhatsAppChannelAccount {
  return {
    channel: "whatsapp",
    accountId: ACCOUNT_ID,
    enabled: true,
    dmPolicy: "allowlist",
    allowedUsers: [],
    agentId: "agent-1",
    selfChatMode: false,
    groupMode: "mention",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const ACCESS_ENV_KEYS = [
  "LETTA_CHANNELS_ALLOWED_USERS",
  "LETTA_CHANNELS_ADMIN_USERS",
  "LETTA_CHANNELS_ALLOW_ALL_USERS",
  "LETTA_WHATSAPP_ALLOWED_USERS",
  "LETTA_WHATSAPP_ADMIN_USERS",
  "LETTA_WHATSAPP_ALLOW_ALL_USERS",
];

describe("WhatsApp access gate", () => {
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    savedEnv.clear();
    for (const key of ACCESS_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    clearChannelAccountStores();
    clearPairingStores();
    __testOverrideLoadPairingStore(() => null);
    __testOverrideLoadChannelAccounts(() => []);
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearChannelAccountStores();
    clearPairingStores();
    __testOverrideLoadPairingStore(null);
    __testOverrideLoadChannelAccounts(null);
  });

  describe("sender access", () => {
    test("reports unrestricted when no account is registered", () => {
      expect(
        evaluateWhatsAppSenderAccess({
          accountId: ACCOUNT_ID,
          senderId: "15550000002",
          chatType: "direct",
        }),
      ).toBe("unrestricted");
    });

    test("allows a sender on the account allowlist", () => {
      __testOverrideLoadChannelAccounts(() => [
        makeAccount({ allowedUsers: ["15550000002"] }),
      ]);
      expect(
        evaluateWhatsAppSenderAccess({
          accountId: ACCOUNT_ID,
          senderId: "15550000002",
          chatType: "direct",
        }),
      ).toBe("allow");
    });

    test("denies a sender outside the account allowlist", () => {
      __testOverrideLoadChannelAccounts(() => [makeAccount()]);
      expect(
        evaluateWhatsAppSenderAccess({
          accountId: ACCOUNT_ID,
          senderId: "15550000003",
          chatType: "direct",
        }),
      ).toBe("deny");
    });

    test("asks an unpaired sender to pair under the pairing policy", () => {
      __testOverrideLoadChannelAccounts(() => [
        makeAccount({ dmPolicy: "pairing" }),
      ]);
      expect(
        evaluateWhatsAppSenderAccess({
          accountId: ACCOUNT_ID,
          senderId: "15550000003",
          chatType: "direct",
        }),
      ).toBe("pair");
    });

    test("denies group senders when the group policy is an allowlist", () => {
      __testOverrideLoadChannelAccounts(() => [
        makeAccount({ groupPolicy: "allowlist" }),
      ]);
      expect(
        evaluateWhatsAppSenderAccess({
          accountId: ACCOUNT_ID,
          senderId: "15550000003",
          chatType: "channel",
        }),
      ).toBe("deny");
    });
  });

  describe("media download policy", () => {
    test("only allowed and unrestricted senders may download media", () => {
      expect(canDownloadWhatsAppMedia("allow")).toBe(true);
      expect(canDownloadWhatsAppMedia("unrestricted")).toBe(true);
      expect(canDownloadWhatsAppMedia("deny")).toBe(false);
      expect(canDownloadWhatsAppMedia("pair")).toBe(false);
    });
  });

  describe("group access", () => {
    const base = {
      groupJid: GROUP_JID,
      text: "hello",
      mentionedJids: [] as string[],
      replyParticipant: null as string | null,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
    };

    test("rejects every group when the group mode is disabled", () => {
      expect(
        evaluateWhatsAppGroupAccess({
          ...base,
          account: makeAccount({ groupMode: "disabled" }),
        }),
      ).toEqual({ allowed: false, reason: "group_disabled" });
    });

    test("rejects a group outside the group allowlist", () => {
      expect(
        evaluateWhatsAppGroupAccess({
          ...base,
          account: makeAccount({ allowedGroups: ["other@g.us"] }),
        }),
      ).toEqual({ allowed: false, reason: "group_not_allowed" });
    });

    test("allows every message in an open group", () => {
      expect(
        evaluateWhatsAppGroupAccess({
          ...base,
          account: makeAccount({ groupMode: "open" }),
        }),
      ).toEqual({ allowed: true, reason: "open_group" });
    });

    test("allows a message that mentions the bot", () => {
      expect(
        evaluateWhatsAppGroupAccess({
          ...base,
          account: makeAccount(),
          mentionedJids: [SELF_PHONE],
        }),
      ).toEqual({ allowed: true, reason: "mention" });
    });

    test("allows a reply to the bot", () => {
      expect(
        evaluateWhatsAppGroupAccess({
          ...base,
          account: makeAccount(),
          replyParticipant: SELF_LID,
        }),
      ).toEqual({ allowed: true, reason: "reply" });
    });

    test("allows a message that matches a mention pattern", () => {
      expect(
        evaluateWhatsAppGroupAccess({
          ...base,
          account: makeAccount({ mentionPatterns: ["^hey bot"] }),
          text: "Hey bot, summarize this",
        }),
      ).toEqual({ allowed: true, reason: "mention_pattern" });
    });

    test("rejects a group message that is not addressed to the bot", () => {
      expect(
        evaluateWhatsAppGroupAccess({
          ...base,
          account: makeAccount(),
        }),
      ).toEqual({ allowed: false, reason: "not_addressed" });
    });
  });
});
