import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutboundChannelMessage } from "@/channels/types";
import {
  createWhatsAppAdapter,
  type WhatsAppAdapterDependencies,
} from "./adapter";
import { createLidStore } from "./lid-store";

const account = {
  channel: "whatsapp" as const,
  accountId: "prefix-adapter",
  displayName: "WhatsApp",
  enabled: true,
  dmPolicy: "pairing" as const,
  allowedUsers: [],
  agentId: "agent-1",
  selfChatMode: false,
  groupMode: "open" as const,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const temporaryDirectories: string[] = [];
const adapters: Array<Awaited<ReturnType<typeof createWhatsAppAdapter>>> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "whatsapp-prefix-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeHarness(messagePrefix?: string) {
  const payloads: Record<string, unknown>[] = [];
  const presence: Array<{ presence: string; jid?: string }> = [];
  const socket = {
    ev: { on() {} },
    ws: { close() {} },
    async sendMessage(_jid: string, payload: Record<string, unknown>) {
      payloads.push(payload);
      return { key: { id: `sent-${payloads.length}` } };
    },
    async sendPresenceUpdate(presenceName: string, jid?: string) {
      presence.push({ presence: presenceName, jid });
    },
  };
  const createSocket: NonNullable<
    WhatsAppAdapterDependencies["createSocket"]
  > = async () => ({
    sock: socket,
    saveCreds: async () => undefined,
    DisconnectReason: {},
    release: () => undefined,
  });
  const adapter = createWhatsAppAdapter(
    { ...account, messagePrefix },
    {
      createSocket,
      loadRuntimeModule: async () => ({}),
      lidStore: createLidStore(join(temporaryDirectory(), "lid-mappings.json")),
    },
  );
  adapters.push(adapter);
  return { adapter, payloads, presence };
}

afterEach(async () => {
  try {
    for (const adapter of adapters) await adapter.stop().catch(() => undefined);
  } finally {
    adapters.length = 0;
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  }
});

async function send(
  adapter: Awaited<ReturnType<typeof createWhatsAppAdapter>>,
  message: OutboundChannelMessage,
) {
  await adapter.start();
  await adapter.sendMessage(message);
}

describe("WhatsApp message prefix adapter behavior", () => {
  test("prefixes text exactly without mutating the caller object", async () => {
    const harness = makeHarness("[bot] ");
    const message: OutboundChannelMessage = {
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: "15550000001@s.whatsapp.net",
      text: "hello",
    };
    await send(harness.adapter, message);
    expect(harness.payloads).toEqual([{ text: "[bot] hello" }]);
    expect(message).toEqual({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: "15550000001@s.whatsapp.net",
      text: "hello",
    });
  });

  test("prefixes non-empty media captions and leaves empty captions absent", async () => {
    const captioned = makeHarness("[bot] ");
    await send(captioned.adapter, {
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: "15550000001@s.whatsapp.net",
      text: "caption",
      mediaPath: "/tmp/photo.png",
    });
    expect(captioned.payloads[0]).toEqual({
      image: { url: "/tmp/photo.png" },
      caption: "[bot] caption",
    });

    for (const text of ["", "   "]) {
      const emptyCaption = makeHarness("[bot] ");
      await send(emptyCaption.adapter, {
        channel: "whatsapp",
        accountId: account.accountId,
        chatId: "15550000001@s.whatsapp.net",
        text,
        mediaPath: "/tmp/photo.png",
      });
      expect(emptyCaption.payloads[0]).toEqual({
        image: { url: "/tmp/photo.png" },
      });
    }
  });

  test("does not prefix reactions or removals and prefixes direct replies", async () => {
    const harness = makeHarness("[bot] ");
    await harness.adapter.start();
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: "15550000001@s.whatsapp.net",
      text: "ignored",
      reaction: "👍",
      targetMessageId: "target",
    });
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: "15550000001@s.whatsapp.net",
      text: "ignored",
      removeReaction: true,
      targetMessageId: "target",
    });
    await harness.adapter.sendDirectReply(
      "15550000001@s.whatsapp.net",
      "reply",
    );
    expect(harness.payloads[0]).toEqual({
      react: {
        text: "👍",
        key: { remoteJid: "15550000001@s.whatsapp.net", id: "target" },
      },
    });
    expect(harness.payloads[1]).toEqual({
      react: {
        text: "",
        key: { remoteJid: "15550000001@s.whatsapp.net", id: "target" },
      },
    });
    expect(harness.payloads[2]).toEqual({ text: "[bot] reply" });
  });

  test("absent and empty prefixes preserve payloads and one-shot composing", async () => {
    for (const prefix of [undefined, ""]) {
      const harness = makeHarness(prefix);
      await send(harness.adapter, {
        channel: "whatsapp",
        accountId: account.accountId,
        chatId: "15550000001@s.whatsapp.net",
        text: "hello",
      });
      expect(harness.payloads).toEqual([{ text: "hello" }]);
      expect(harness.presence).toEqual([
        { presence: "composing", jid: "15550000001@s.whatsapp.net" },
      ]);
    }
  });
});
