import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  OutboundChannelMessage,
} from "@/channels/types";
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

const chatId = "15550000001@s.whatsapp.net";
const prefix = "[bot] ";

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

function directSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "whatsapp",
    accountId: account.accountId,
    chatId,
    chatType: "direct",
    senderId: "15550000001",
    messageId: "incoming-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    ...overrides,
  };
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

function payloadText(payload: Record<string, unknown>): string {
  if (typeof payload.text !== "string")
    throw new Error("expected text payload");
  return payload.text;
}

describe("WhatsApp message prefix adapter behavior", () => {
  test("prefixes text exactly once without mutating the caller object", async () => {
    const harness = makeHarness(prefix);
    const message: OutboundChannelMessage = {
      channel: "whatsapp",
      accountId: account.accountId,
      chatId,
      text: "hello",
    };
    await send(harness.adapter, message);
    await harness.adapter.sendMessage(message);
    expect(harness.payloads).toEqual([
      { text: "[bot] hello" },
      { text: "[bot] hello" },
    ]);
    expect(message).toEqual({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId,
      text: "hello",
    });
  });

  test("prefixes final media captions exactly once after text/title selection", async () => {
    const cases: Array<{
      name: string;
      message: OutboundChannelMessage;
      payload: Record<string, unknown>;
    }> = [
      {
        name: "image text caption",
        message: {
          channel: "whatsapp",
          accountId: account.accountId,
          chatId,
          text: "caption",
          mediaPath: "/tmp/photo.png",
        },
        payload: {
          image: { url: "/tmp/photo.png" },
          caption: "[bot] caption",
        },
      },
      {
        name: "video title caption",
        message: {
          channel: "whatsapp",
          accountId: account.accountId,
          chatId,
          text: "",
          title: "clip title",
          mediaPath: "/tmp/clip.mp4",
        },
        payload: {
          video: { url: "/tmp/clip.mp4" },
          caption: "[bot] clip title",
        },
      },
      {
        name: "text beats title",
        message: {
          channel: "whatsapp",
          accountId: account.accountId,
          chatId,
          text: "caption",
          title: "ignored title",
          mediaPath: "/tmp/second.jpg",
        },
        payload: {
          image: { url: "/tmp/second.jpg" },
          caption: "[bot] caption",
        },
      },
      {
        name: "document title caption",
        message: {
          channel: "whatsapp",
          accountId: account.accountId,
          chatId,
          text: "",
          title: "document title",
          mediaPath: "/tmp/report.pdf",
        },
        payload: {
          document: { url: "/tmp/report.pdf" },
          fileName: "report.pdf",
          mimetype: "application/pdf",
          caption: "[bot] document title",
        },
      },
    ];

    for (const testCase of cases) {
      const harness = makeHarness(prefix);
      await send(harness.adapter, testCase.message);
      expect(harness.payloads[0]).toEqual(testCase.payload);
    }
  });

  test("leaves empty media captions absent and voice memos captionless", async () => {
    for (const mediaPath of ["/tmp/photo.png", "/tmp/report.pdf"]) {
      const emptyCaption = makeHarness(prefix);
      await send(emptyCaption.adapter, {
        channel: "whatsapp",
        accountId: account.accountId,
        chatId,
        text: "   ",
        title: "   ",
        mediaPath,
      });
      expect(emptyCaption.payloads[0]).not.toHaveProperty("caption");
    }

    const voiceMemo = makeHarness(prefix);
    await send(voiceMemo.adapter, {
      channel: "whatsapp",
      accountId: account.accountId,
      chatId,
      text: "voice caption",
      title: "voice title",
      mediaPath: "/tmp/voice.ogg",
    });
    expect(voiceMemo.payloads[0]).toEqual({
      audio: { url: "/tmp/voice.ogg" },
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });
  });

  test("does not prefix reactions or removals and only prefixes opt-in direct replies", async () => {
    const harness = makeHarness(prefix);
    await harness.adapter.start();
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId,
      text: "ignored",
      reaction: "ok",
      targetMessageId: "target",
    });
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId,
      text: "ignored",
      removeReaction: true,
      targetMessageId: "target",
    });
    await harness.adapter.sendDirectReply(chatId, "system reply");
    await harness.adapter.sendDirectReply(chatId, "ordinary reply", {
      applyMessagePrefix: true,
    });

    expect(harness.payloads[0]).toEqual({
      react: {
        text: "ok",
        key: { remoteJid: chatId, id: "target" },
      },
    });
    expect(harness.payloads[1]).toEqual({
      react: {
        text: "",
        key: { remoteJid: chatId, id: "target" },
      },
    });
    expect(harness.payloads[2]).toEqual({ text: "system reply" });
    expect(harness.payloads[3]).toEqual({ text: "[bot] ordinary reply" });
  });

  test("approval control prompts and lifecycle error replies are unprefixed", async () => {
    const harness = makeHarness(prefix);
    await harness.adapter.start();

    await harness.adapter.handleControlRequestEvent?.({
      requestId: "approval-1",
      kind: "generic_tool_approval",
      source: directSource(),
      toolName: "Bash",
      input: { command: "pwd" },
    } satisfies ChannelControlRequestEvent);

    await harness.adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      outcome: "error",
      batchId: "batch-1",
      runId: "run-1",
      stopReason: "error",
      error: "boom",
      sources: [directSource({ messageId: "incoming-2" })],
    } satisfies ChannelTurnLifecycleEvent);

    expect(harness.payloads).toHaveLength(2);
    const [controlPayload, lifecyclePayload] = harness.payloads;
    if (!controlPayload || !lifecyclePayload) {
      throw new Error("expected control and lifecycle payloads");
    }
    const controlText = payloadText(controlPayload);
    const lifecycleText = payloadText(lifecyclePayload);
    expect(controlText).toStartWith("The agent wants approval");
    expect(controlText).not.toStartWith(prefix);
    expect(lifecycleText).toStartWith("Turn failed:");
    expect(lifecycleText).not.toStartWith(prefix);
  });

  test("absent and empty prefixes preserve payloads and one-shot composing", async () => {
    for (const emptyPrefix of [undefined, ""]) {
      const harness = makeHarness(emptyPrefix);
      await send(harness.adapter, {
        channel: "whatsapp",
        accountId: account.accountId,
        chatId,
        text: "hello",
      });
      expect(harness.payloads).toEqual([{ text: "hello" }]);
      expect(harness.presence).toEqual([
        { presence: "composing", jid: chatId },
      ]);
    }
  });
});
