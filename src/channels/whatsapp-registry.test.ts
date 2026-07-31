import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
  getApprovedUsers,
  getPendingPairings,
} from "@/channels/pairing";
import {
  ChannelRegistry,
  completePairing,
  getChannelRegistry,
} from "@/channels/registry";
import type { ChannelInboundDelivery } from "@/channels/registry-handlers";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoutesForChannel,
} from "@/channels/routing";
import type { WhatsAppChannelAccount } from "@/channels/types";
import {
  createWhatsAppAdapter,
  type WhatsAppAdapterDependencies,
} from "@/channels/whatsapp/adapter";
import {
  WHATSAPP_LID_SUFFIX,
  WHATSAPP_PHONE_SUFFIX,
} from "@/channels/whatsapp/jid";
import { createLidStore } from "@/channels/whatsapp/lid-store";

const ACCESS_ENV_KEYS = [
  "LETTA_CHANNELS_ALLOWED_USERS",
  "LETTA_CHANNELS_ADMIN_USERS",
  "LETTA_CHANNELS_ALLOW_ALL_USERS",
  "LETTA_WHATSAPP_ALLOWED_USERS",
  "LETTA_WHATSAPP_ADMIN_USERS",
  "LETTA_WHATSAPP_ALLOW_ALL_USERS",
] as const;

const ACCOUNT_ID = "registry-whatsapp";
const CANONICAL_PHONE = "15550000999";
const CANONICAL_PHONE_JID = `${CANONICAL_PHONE}${WHATSAPP_PHONE_SUFFIX}`;
const RAW_LID = `90000123${WHATSAPP_LID_SUFFIX}`;
const SELF_PHONE_JID = `15550000001${WHATSAPP_PHONE_SUFFIX}`;
const SELF_LID = `70000001${WHATSAPP_LID_SUFFIX}`;
const ROUTE_AGENT = "agent-registry-proof";
const ROUTE_CONVERSATION = "conversation-registry-proof";

type RegistryHarness = {
  deliveries: ChannelInboundDelivery[];
  sendCount: number;
  emit: (messages: Record<string, unknown>[]) => Promise<void>;
  emitReaction: (entries: Record<string, unknown>[]) => Promise<void>;
};

function makeAccount(
  overrides: Partial<WhatsAppChannelAccount> = {},
): WhatsAppChannelAccount {
  return {
    channel: "whatsapp",
    accountId: ACCOUNT_ID,
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    agentId: null,
    selfChatMode: false,
    groupMode: "open",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeMessage(
  remoteJid: string,
  id: string,
  key: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: { remoteJid, id, ...key },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

function makeReactionEntry(
  remoteJid: string,
  id: string,
  key: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: { remoteJid, id: "target-message", fromMe: true },
    reaction: {
      key: { remoteJid, id, fromMe: false, ...key },
      text: "👍",
      senderTimestampMs: Date.now(),
    },
  };
}

async function makeHarness(
  account: WhatsAppChannelAccount,
  lidPath: string,
): Promise<RegistryHarness> {
  const upsertHandlers: Array<(payload: unknown) => unknown> = [];
  const reactionHandlers: Array<(payload: unknown) => unknown> = [];
  const deliveries: ChannelInboundDelivery[] = [];
  let sendCount = 0;

  const createSocket: NonNullable<
    WhatsAppAdapterDependencies["createSocket"]
  > = async () => {
    const socket = {
      ev: {
        on(event: string, handler: (payload: unknown) => void) {
          if (event === "messages.upsert") upsertHandlers.push(handler);
          if (event === "messages.reaction") reactionHandlers.push(handler);
        },
      },
      ws: { close() {} },
      user: { id: SELF_PHONE_JID, lid: SELF_LID },
      async sendMessage() {
        sendCount += 1;
        return { key: { id: `outbound-${sendCount}` } };
      },
    };
    return {
      sock: socket,
      saveCreds: async () => undefined,
      DisconnectReason: {},
      release: () => undefined,
    };
  };

  const adapter = createWhatsAppAdapter(account, {
    createSocket,
    loadRuntimeModule: async () => ({}),
    lidStore: createLidStore(lidPath),
  });
  const registry = new ChannelRegistry();
  registry.registerAdapter(adapter);
  registry.setMessageHandler((delivery) => {
    deliveries.push(delivery);
  });
  registry.setReady();
  await adapter.start();

  return {
    deliveries,
    get sendCount() {
      return sendCount;
    },
    async emit(messages) {
      const handler = upsertHandlers.at(-1);
      if (!handler) throw new Error("messages.upsert handler was not captured");
      await handler({ type: "notify", messages });
    },
    async emitReaction(entries) {
      const handler = reactionHandlers.at(-1);
      if (!handler)
        throw new Error("messages.reaction handler was not captured");
      await handler(entries);
    },
  };
}

function clearStores(): void {
  clearChannelAccountStores();
  clearAllRoutes();
  clearPairingStores();
}

function installCleanStores(): void {
  clearStores();

  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
  __testOverrideLoadPairingStore(() => null);
  __testOverrideSavePairingStore(() => {});
}

function restoreStores(): void {
  clearStores();

  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
  __testOverrideLoadPairingStore(null);
  __testOverrideSavePairingStore(null);
}

describe("WhatsApp canonical identity through ChannelRegistry", () => {
  let tempDir = "";
  let savedEnvironment = new Map<string, string | undefined>();

  beforeEach(() => {
    savedEnvironment = new Map(
      ACCESS_ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    for (const key of ACCESS_ENV_KEYS) delete process.env[key];
    tempDir = mkdtempSync(join(tmpdir(), "whatsapp-registry-test-"));
    installCleanStores();
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) await registry.stopAll();
    restoreStores();
    for (const key of ACCESS_ENV_KEYS) {
      const value = savedEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("allowlist and route converge across LID and PN forms", async () => {
    const account = makeAccount({ allowedUsers: [CANONICAL_PHONE] });
    __testOverrideLoadChannelAccounts(() => [account]);
    addRoute("whatsapp", {
      accountId: ACCOUNT_ID,
      chatId: CANONICAL_PHONE_JID,
      chatType: "direct",
      threadId: null,
      agentId: ROUTE_AGENT,
      conversationId: ROUTE_CONVERSATION,
      enabled: true,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    const harness = await makeHarness(account, join(tempDir, "lid.json"));
    await harness.emit([
      makeMessage(RAW_LID, "lid-form", { senderPn: CANONICAL_PHONE_JID }),
      makeMessage(CANONICAL_PHONE_JID, "pn-form"),
    ]);

    expect(harness.deliveries).toHaveLength(2);
    for (const delivery of harness.deliveries) {
      expect(delivery.route).toMatchObject({
        chatId: CANONICAL_PHONE_JID,
        agentId: ROUTE_AGENT,
        conversationId: ROUTE_CONVERSATION,
      });
    }
    expect(getRoutesForChannel("whatsapp", ACCOUNT_ID)).toHaveLength(1);
    expect(getPendingPairings("whatsapp", ACCOUNT_ID)).toHaveLength(0);
    expect(harness.sendCount).toBe(0);
  });

  test("unpaired reactions do not create pairing prompts", async () => {
    const account = makeAccount();
    __testOverrideLoadChannelAccounts(() => [account]);
    const harness = await makeHarness(account, join(tempDir, "lid.json"));

    await harness.emitReaction([
      makeReactionEntry(RAW_LID, "pending-reaction", {
        senderPn: CANONICAL_PHONE_JID,
        senderLid: RAW_LID,
      }),
    ]);

    expect(harness.deliveries).toHaveLength(0);
    expect(getPendingPairings("whatsapp", ACCOUNT_ID)).toHaveLength(0);
    expect(harness.sendCount).toBe(0);
  });

  test("pairing approval converges future LID and PN forms", async () => {
    const account = makeAccount();
    __testOverrideLoadChannelAccounts(() => [account]);
    const harness = await makeHarness(account, join(tempDir, "lid.json"));

    await harness.emit([
      makeMessage(RAW_LID, "pairing-request", {
        senderPn: CANONICAL_PHONE_JID,
      }),
    ]);

    const pending = getPendingPairings("whatsapp", ACCOUNT_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        senderId: CANONICAL_PHONE,
        chatId: CANONICAL_PHONE_JID,
      }),
    );
    expect(harness.sendCount).toBe(1);

    const code = pending[0]?.code;
    if (!code) throw new Error("pairing code was not created");
    expect(
      completePairing(
        "whatsapp",
        code,
        ROUTE_AGENT,
        ROUTE_CONVERSATION,
        ACCOUNT_ID,
      ),
    ).toMatchObject({
      success: true,
      chatId: CANONICAL_PHONE_JID,
      accountId: ACCOUNT_ID,
    });

    const sendsAfterPairing = harness.sendCount;
    await harness.emit([
      makeMessage(RAW_LID, "approved-lid-form"),
      makeMessage(CANONICAL_PHONE_JID, "approved-pn-form"),
    ]);

    expect(harness.deliveries).toHaveLength(2);
    expect(
      harness.deliveries.every(
        (delivery) =>
          delivery.route.chatId === CANONICAL_PHONE_JID &&
          delivery.route.agentId === ROUTE_AGENT &&
          delivery.route.conversationId === ROUTE_CONVERSATION,
      ),
    ).toBe(true);
    expect(getRoutesForChannel("whatsapp", ACCOUNT_ID)).toHaveLength(1);
    expect(getPendingPairings("whatsapp", ACCOUNT_ID)).toHaveLength(0);
    const approved = getApprovedUsers("whatsapp", ACCOUNT_ID);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toEqual(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        senderId: CANONICAL_PHONE,
      }),
    );
    expect(harness.sendCount).toBe(sendsAfterPairing);
  });
});
