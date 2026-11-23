import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import type {
  ChannelMessageAttachment,
  WhatsAppChannelAccount,
} from "@/channels/types";
import { prepareWhatsAppInboundMessage } from "./inbound-prepare";
import {
  WHATSAPP_GROUP_SUFFIX,
  WHATSAPP_LID_SUFFIX,
  WHATSAPP_PHONE_SUFFIX,
} from "./jid";

const ACCOUNT_ID = "prepare-test";
const SELF_PHONE = `15550000001${WHATSAPP_PHONE_SUFFIX}`;
const SELF_LID = `999000111${WHATSAPP_LID_SUFFIX}`;
const GROUP_JID = `120363000000000000${WHATSAPP_GROUP_SUFFIX}`;
const SENDER_ID = "15550000002";

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
    downloadMedia: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function imageMessage(): Record<string, unknown> {
  return {
    imageMessage: { mimetype: "image/jpeg", fileLength: 128 },
  };
}

function voiceNoteMessage(): Record<string, unknown> {
  return {
    audioMessage: { mimetype: "audio/ogg", ptt: true, fileLength: 256 },
  };
}

function textMessage(text: string): Record<string, unknown> {
  return { conversation: text };
}

function mentionMessage(text: string): Record<string, unknown> {
  return {
    extendedTextMessage: {
      text,
      contextInfo: { mentionedJid: [SELF_PHONE] },
    },
  };
}

function attachment(
  overrides: Partial<ChannelMessageAttachment> = {},
): ChannelMessageAttachment {
  return {
    id: "attachment-1",
    name: "photo.jpg",
    mimeType: "image/jpeg",
    kind: "image",
    localPath: "",
    ...overrides,
  };
}

describe("WhatsApp inbound preparation", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "whatsapp-inbound-"));
    clearChannelAccountStores();
    clearPairingStores();
    __testOverrideLoadPairingStore(() => null);
    __testOverrideLoadChannelAccounts(() => []);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    clearChannelAccountStores();
    clearPairingStores();
    __testOverrideLoadPairingStore(null);
    __testOverrideLoadChannelAccounts(null);
  });

  test("drops a group message that is not addressed to the bot before any download", async () => {
    const calls: boolean[] = [];
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount(),
      chatId: GROUP_JID,
      senderId: SENDER_ID,
      message: imageMessage(),
      isGroup: true,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async (downloadMedia) => {
        calls.push(downloadMedia);
        return { attachments: [attachment()] };
      },
      isActive: () => true,
    });

    expect(result).toEqual({ kind: "drop", reason: "not_addressed" });
    expect(calls).toEqual([]);
  });

  test("delivers a group message that mentions the bot and downloads its media", async () => {
    const calls: boolean[] = [];
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount(),
      chatId: GROUP_JID,
      senderId: SENDER_ID,
      message: mentionMessage("hey bot"),
      isGroup: true,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async (downloadMedia) => {
        calls.push(downloadMedia);
        return { attachments: [attachment()] };
      },
      isActive: () => true,
    });

    expect(result.kind).toBe("deliver");
    expect(calls).toEqual([true]);
    if (result.kind !== "deliver") return;
    expect(result.body).toBe("hey bot");
    expect(result.attachments).toHaveLength(1);
  });

  test("keeps a denied sender's message but never downloads its media", async () => {
    __testOverrideLoadChannelAccounts(() => [
      makeAccount({ allowedUsers: ["15550000009"] }),
    ]);
    const calls: boolean[] = [];
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount(),
      chatId: `${SENDER_ID}${WHATSAPP_PHONE_SUFFIX}`,
      senderId: SENDER_ID,
      message: imageMessage(),
      isGroup: false,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async (downloadMedia) => {
        calls.push(downloadMedia);
        return { attachments: [attachment()] };
      },
      isActive: () => true,
    });

    expect(result.kind).toBe("deliver");
    expect(calls).toEqual([false]);
    if (result.kind !== "deliver") return;
    expect(result.mediaSkipReason).toBe("sender_not_allowed");
  });

  test("keeps an unpaired sender's message but never downloads its media", async () => {
    __testOverrideLoadChannelAccounts(() => [
      makeAccount({ dmPolicy: "pairing" }),
    ]);
    const calls: boolean[] = [];
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount({ dmPolicy: "pairing" }),
      chatId: `${SENDER_ID}${WHATSAPP_PHONE_SUFFIX}`,
      senderId: SENDER_ID,
      message: imageMessage(),
      isGroup: false,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async (downloadMedia) => {
        calls.push(downloadMedia);
        return { attachments: [attachment()] };
      },
      isActive: () => true,
    });

    expect(result.kind).toBe("deliver");
    expect(calls).toEqual([false]);
    if (result.kind !== "deliver") return;
    expect(result.mediaSkipReason).toBe("sender_not_paired");
  });

  test("transcribes a group voice note and keeps it when the transcript addresses the bot", async () => {
    const calls: boolean[] = [];
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount({
        transcribeVoice: true,
        mentionPatterns: ["hey bot"],
      }),
      chatId: GROUP_JID,
      senderId: SENDER_ID,
      message: voiceNoteMessage(),
      isGroup: true,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async (downloadMedia) => {
        calls.push(downloadMedia);
        return {
          attachments: [attachment({ kind: "audio", localPath: "/tmp/none" })],
          transcriptionText: "[Voice message]: hey bot",
        };
      },
      isActive: () => true,
    });

    expect(result.kind).toBe("deliver");
    expect(calls).toEqual([true]);
    if (result.kind !== "deliver") return;
    expect(result.body).toBe("[Voice message]: hey bot");
  });

  test("removes the probed voice note when its transcript does not address the bot", async () => {
    const localPath = join(tempDir, "voice-note.ogg");
    writeFileSync(localPath, "audio");
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount({
        transcribeVoice: true,
        mentionPatterns: ["hey bot"],
      }),
      chatId: GROUP_JID,
      senderId: SENDER_ID,
      message: voiceNoteMessage(),
      isGroup: true,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async () => ({
        attachments: [attachment({ kind: "audio", localPath })],
        transcriptionText: "[Voice message]: what is the weather",
      }),
      isActive: () => true,
    });

    expect(result).toEqual({ kind: "drop", reason: "not_addressed" });
    expect(existsSync(localPath)).toBe(false);
  });

  test("drops a message that carries neither text nor an attachment", async () => {
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount(),
      chatId: `${SENDER_ID}${WHATSAPP_PHONE_SUFFIX}`,
      senderId: SENDER_ID,
      message: textMessage("   "),
      isGroup: false,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async () => ({ attachments: [] }),
      isActive: () => true,
    });

    expect(result).toEqual({ kind: "drop", reason: "empty" });
  });

  test("aborts when the connection went away while the media was collected", async () => {
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount(),
      chatId: `${SENDER_ID}${WHATSAPP_PHONE_SUFFIX}`,
      senderId: SENDER_ID,
      message: imageMessage(),
      isGroup: false,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async () => ({
        attachments: [attachment()] as ChannelMessageAttachment[],
      }),
      isActive: () => false,
    });

    expect(result).toEqual({ kind: "abort" });
  });

  test("does not consult the sender policy for a text-only message", async () => {
    __testOverrideLoadChannelAccounts(() => [makeAccount()]);
    const result = await prepareWhatsAppInboundMessage({
      account: makeAccount(),
      chatId: `${SENDER_ID}${WHATSAPP_PHONE_SUFFIX}`,
      senderId: SENDER_ID,
      message: textMessage("hello"),
      isGroup: false,
      selfPhoneJid: SELF_PHONE,
      selfLid: SELF_LID,
      collectAttachments: async () => ({ attachments: [] }),
      isActive: () => true,
    });

    expect(result.kind).toBe("deliver");
    if (result.kind !== "deliver") return;
    expect(result.mediaSkipReason).toBeUndefined();
  });
});
