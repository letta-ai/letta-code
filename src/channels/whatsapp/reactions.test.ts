import { describe, expect, test } from "bun:test";
import {
  isWhatsAppReactionGroupEligible,
  parseWhatsAppReactionEntry,
} from "./reactions";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    key: {
      remoteJid: "120363-987@g.us",
      id: "target-message",
      fromMe: true,
      participant: "15550000002@s.whatsapp.net",
    },
    reaction: {
      key: {
        remoteJid: "120363-987:4@g.us",
        id: "reaction-event",
        participant: "15550000003@s.whatsapp.net",
      },
      text: "👍",
      senderTimestampMs: 1710000000123,
    },
    ...overrides,
  };
}

describe("WhatsApp reaction parser", () => {
  test("parses an added emoji and preserves both keys", () => {
    const parsed = parseWhatsAppReactionEntry(entry());
    expect(parsed).toEqual({
      targetKey: expect.objectContaining({
        id: "target-message",
        remoteJid: "120363-987@g.us",
      }),
      reactionKey: expect.objectContaining({
        id: "reaction-event",
        remoteJid: "120363-987@g.us",
      }),
      chatId: "120363-987@g.us",
      reactionMessageId: "reaction-event",
      targetMessageId: "target-message",
      targetFromMe: true,
      reactorParticipant: "15550000003@s.whatsapp.net",
      action: "added",
      emoji: "👍",
      timestampMs: 1710000000123,
    });
  });

  test("parses empty, null, and undefined text as removals", () => {
    for (const text of ["", "   ", null, undefined]) {
      const parsed = parseWhatsAppReactionEntry(
        entry({ reaction: { ...entry().reaction, text } }),
      );
      expect(parsed?.action).toBe("removed");
      expect(parsed?.emoji).toBe("");
    }
  });

  test("preserves Baileys PN/LID identity fields on reaction keys", () => {
    const parsed = parseWhatsAppReactionEntry(
      entry({
        reaction: {
          ...entry().reaction,
          key: {
            remoteJid: "120363-987@g.us",
            id: "reaction-event",
            participant: "200000@lid",
            participantPn: "15550000003@s.whatsapp.net",
            participantLid: "200000@lid",
            senderPn: "15550000004@s.whatsapp.net",
            senderLid: "300000@lid",
          },
        },
      }),
    );

    expect(parsed?.reactionKey).toEqual(
      expect.objectContaining({
        participant: "200000@lid",
        participantPn: "15550000003@s.whatsapp.net",
        participantLid: "200000@lid",
        senderPn: "15550000004@s.whatsapp.net",
        senderLid: "300000@lid",
      }),
    );
  });

  test("preserves group participants and accepts numeric/toNumber timestamps", () => {
    const numeric = parseWhatsAppReactionEntry(entry());
    expect(numeric?.reactorParticipant).toBe("15550000003@s.whatsapp.net");
    expect(numeric?.timestampMs).toBe(1710000000123);

    const boxed = parseWhatsAppReactionEntry(
      entry({
        reaction: {
          ...entry().reaction,
          senderTimestampMs: { toNumber: () => 1710000000999 },
        },
      }),
    );
    expect(boxed?.timestampMs).toBe(1710000000999);
  });

  test("rejects malformed entries without throwing", () => {
    const invalidEntries: unknown[] = [
      entry({ key: { remoteJid: "120363-987@g.us" } }),
      entry({ reaction: { key: { remoteJid: "120363-987@g.us" } } }),
      entry({ key: "not-an-object" }),
      entry({
        reaction: {
          ...entry().reaction,
          key: { remoteJid: "120363-988@g.us", id: "reaction-event" },
        },
      }),
      entry({
        reaction: { ...entry().reaction, text: { emoji: "👍" } },
      }),
      entry({
        reaction: { ...entry().reaction, text: "x".repeat(65) },
      }),
      entry({
        reaction: {
          ...entry().reaction,
          key: {
            remoteJid: "120363-987@g.us",
            id: "reaction-event",
            senderPn: 123,
          },
        },
      }),
      entry({ key: { remoteJid: "malformed", id: "target-message" } }),
    ];

    for (const invalid of invalidEntries) {
      expect(() => parseWhatsAppReactionEntry(invalid)).not.toThrow();
      expect(parseWhatsAppReactionEntry(invalid)).toBeNull();
    }
  });
});

describe("WhatsApp reaction group policy", () => {
  const groupJid = "120363-987@g.us";

  test("enforces disabled, allowlist, open, and mention behavior", () => {
    expect(
      isWhatsAppReactionGroupEligible({
        groupMode: "disabled",
        groupJid,
        targetFromMe: true,
      }),
    ).toBe(false);
    expect(
      isWhatsAppReactionGroupEligible({
        groupMode: "open",
        allowedGroups: ["120363-other@g.us"],
        groupJid,
        targetFromMe: true,
      }),
    ).toBe(false);
    expect(
      isWhatsAppReactionGroupEligible({
        groupMode: "open",
        allowedGroups: [groupJid],
        groupJid: "120363-987:4@g.us",
        targetFromMe: true,
      }),
    ).toBe(true);
    expect(
      isWhatsAppReactionGroupEligible({
        groupMode: "mention",
        groupJid,
        targetFromMe: true,
      }),
    ).toBe(true);
    expect(
      isWhatsAppReactionGroupEligible({
        groupMode: "mention",
        groupJid,
        targetFromMe: false,
      }),
    ).toBe(false);
  });
});
