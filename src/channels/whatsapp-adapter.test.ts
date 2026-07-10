import { describe, expect, test } from "bun:test";
import {
  createWhatsAppAdapter,
  isWhatsAppConflictDisconnect,
  resolvePresenceJid,
} from "@/channels/whatsapp/adapter";

describe("WhatsApp adapter helpers", () => {
  test("detects session conflict disconnects by message", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { message: "Stream Errored (conflict)" } },
      }),
    ).toBe(true);
  });

  test("detects session conflict disconnects by status code", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 440 } } },
      }),
    ).toBe(true);
  });

  test("ignores non-conflict disconnects", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { message: "timed out" } },
      }),
    ).toBe(false);
  });

  test("implements turn lifecycle event handling", async () => {
    const adapter = createWhatsAppAdapter({
      channel: "whatsapp",
      accountId: "main",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      agentId: "agent-whatsapp",
      selfChatMode: true,
      groupMode: "disabled",
    });

    expect(adapter.handleTurnLifecycleEvent).toBeTypeOf("function");

    await expect(
      adapter.handleTurnLifecycleEvent?.({
        type: "finished",
        batchId: "batch-1",
        outcome: "error",
        stopReason: "error",
        error: "Turn failed",
        sources: [
          {
            channel: "whatsapp",
            accountId: "main",
            chatId: "15551234567@s.whatsapp.net",
            messageId: "msg-1",
            agentId: "agent-whatsapp",
            conversationId: "conv-whatsapp",
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("resolvePresenceJid", () => {
  test("returns the LID when the phone JID has a reverse mapping", () => {
    const jidToLid = new Map([
      ["15551234567@s.whatsapp.net", "abc123456789@lid"],
    ]);
    expect(
      resolvePresenceJid({ targetJid: "15551234567@s.whatsapp.net", jidToLid }),
    ).toBe("abc123456789@lid");
  });

  test("falls back to the phone JID when no LID mapping exists", () => {
    const jidToLid = new Map<string, string>();
    expect(
      resolvePresenceJid({ targetJid: "15551234567@s.whatsapp.net", jidToLid }),
    ).toBe("15551234567@s.whatsapp.net");
  });

  test("passes through group JIDs unchanged (no LID mapping)", () => {
    const jidToLid = new Map<string, string>();
    expect(resolvePresenceJid({ targetJid: "120363@g.us", jidToLid })).toBe(
      "120363@g.us",
    );
  });
});
