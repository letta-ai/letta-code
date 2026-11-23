import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  __testOverrideLoadPairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import type {
  InboundChannelMessage,
  WhatsAppChannelAccount,
} from "@/channels/types";
import {
  createWhatsAppAdapter,
  type WhatsAppAdapterDependencies,
} from "@/channels/whatsapp/adapter";
import {
  WHATSAPP_GROUP_SUFFIX,
  WHATSAPP_LID_SUFFIX,
  WHATSAPP_PHONE_SUFFIX,
} from "@/channels/whatsapp/jid";
import { createLidStore } from "@/channels/whatsapp/lid-store";

const ACCOUNT_ID = "media-access-test";
const SELF_PHONE = `15551234567${WHATSAPP_PHONE_SUFFIX}`;
const SELF_LID = `777000111${WHATSAPP_LID_SUFFIX}`;
const GROUP_JID = `120363000000000000${WHATSAPP_GROUP_SUFFIX}`;
const SENDER_PHONE = `15550000051${WHATSAPP_PHONE_SUFFIX}`;

function makeAccount(
  overrides: Partial<WhatsAppChannelAccount> = {},
): WhatsAppChannelAccount {
  return {
    channel: "whatsapp",
    accountId: ACCOUNT_ID,
    enabled: true,
    dmPolicy: "open",
    allowedUsers: [],
    agentId: "agent-test",
    selfChatMode: false,
    groupMode: "mention",
    downloadMedia: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function imageMessage(mentionedJids: string[] = []): Record<string, unknown> {
  return {
    imageMessage: {
      mimetype: "image/jpeg",
      fileLength: 4,
      contextInfo: { mentionedJid: mentionedJids },
    },
  };
}

function makeMessage(
  remoteJid: string,
  id: string,
  message: Record<string, unknown>,
  key: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: { remoteJid, id, ...key },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

function makeHarness(options: {
  account: WhatsAppChannelAccount;
  onMessage: (message: InboundChannelMessage) => Promise<void>;
  downloadContentFromMessage: (
    message: unknown,
    type: string,
  ) => Promise<AsyncIterable<Uint8Array>>;
  lidPath: string;
}) {
  let upsertHandler: ((payload: unknown) => unknown) | undefined;
  const socket = {
    ev: {
      on(event: string, handler: (payload: unknown) => void) {
        if (event === "messages.upsert") upsertHandler = handler;
      },
    },
    ws: { close() {} },
    user: { id: SELF_PHONE, lid: SELF_LID },
    async sendMessage() {
      return { key: { id: "outbound" } };
    },
  };
  let connectionUpdate:
    | ((update: Record<string, unknown>) => unknown)
    | undefined;
  const dependencies: WhatsAppAdapterDependencies = {
    createSocket: async (runtimeOptions) => {
      connectionUpdate = runtimeOptions.onConnectionUpdate as (
        update: Record<string, unknown>,
      ) => unknown;
      return {
        sock: socket,
        saveCreds: async () => undefined,
        DisconnectReason: {},
        release: () => undefined,
      };
    },
    loadRuntimeModule: async () => ({
      downloadContentFromMessage: options.downloadContentFromMessage,
    }),
    lidStore: createLidStore(options.lidPath),
  };
  const adapter = createWhatsAppAdapter(options.account, dependencies);
  adapter.onMessage = options.onMessage;
  return {
    adapter,
    async emit(messages: Record<string, unknown>[]) {
      await upsertHandler?.({ type: "notify", messages });
    },
    openConnection() {
      connectionUpdate?.({ connection: "open" });
    },
  };
}

describe("WhatsApp adapter media access gating", () => {
  let channelsRoot = "";
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "whatsapp-media-access-"));
    channelsRoot = join(dir, "channels");
    __testOverrideChannelsRoot(channelsRoot);
    clearChannelAccountStores();
    clearPairingStores();
    __testOverrideLoadPairingStore(() => null);
  });

  afterEach(() => {
    __testOverrideChannelsRoot(null);
    __testOverrideLoadChannelAccounts(null);
    clearChannelAccountStores();
    clearPairingStores();
    __testOverrideLoadPairingStore(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("never downloads media for a group message that is not addressed to the bot", async () => {
    const account = makeAccount();
    __testOverrideLoadChannelAccounts(() => [account]);
    const downloads: string[] = [];
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness({
      account,
      onMessage: async (message) => {
        received.push(message);
      },
      downloadContentFromMessage: async (_message, type) => {
        downloads.push(type);
        async function* empty() {}
        return empty();
      },
      lidPath: join(dir, "lid.json"),
    });
    await harness.adapter.start();
    harness.openConnection();

    await harness.emit([
      makeMessage(GROUP_JID, "ambient", imageMessage(), {
        participant: SENDER_PHONE,
      }),
    ]);

    expect(downloads).toEqual([]);
    expect(received).toEqual([]);
  });

  test("downloads media for a group message that mentions the bot", async () => {
    const account = makeAccount();
    __testOverrideLoadChannelAccounts(() => [account]);
    const downloads: string[] = [];
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness({
      account,
      onMessage: async (message) => {
        received.push(message);
      },
      downloadContentFromMessage: async (_message, type) => {
        downloads.push(type);
        async function* content() {
          yield Buffer.from("1234");
        }
        return content();
      },
      lidPath: join(dir, "lid.json"),
    });
    await harness.adapter.start();
    harness.openConnection();

    await harness.emit([
      makeMessage(GROUP_JID, "mention", imageMessage([SELF_PHONE]), {
        participant: SENDER_PHONE,
      }),
    ]);

    expect(downloads).toEqual(["image"]);
    expect(received).toHaveLength(1);
    expect(received[0]?.attachments?.[0]?.localPath).toContain("attachments");
  });

  test("keeps a denied sender's message but never downloads its media", async () => {
    const account = makeAccount({ dmPolicy: "allowlist", allowedUsers: [] });
    __testOverrideLoadChannelAccounts(() => [account]);
    const downloads: string[] = [];
    const received: InboundChannelMessage[] = [];
    const harness = makeHarness({
      account,
      onMessage: async (message) => {
        received.push(message);
      },
      downloadContentFromMessage: async (_message, type) => {
        downloads.push(type);
        async function* content() {
          yield Buffer.from("1234");
        }
        return content();
      },
      lidPath: join(dir, "lid.json"),
    });
    await harness.adapter.start();
    harness.openConnection();

    await harness.emit([makeMessage(SENDER_PHONE, "denied", imageMessage())]);

    expect(downloads).toEqual([]);
    expect(received).toHaveLength(1);
    expect(received[0]?.attachments?.[0]?.localPath).toBe("");
  });
});
