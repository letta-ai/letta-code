import { describe, expect, it } from "bun:test";
import { normalizeMessageKey } from "./message-key";

describe("normalizeMessageKey", () => {
  it("returns normalized fields from a full Baileys-6 key shape", () => {
    const key = {
      remoteJid: "1234567890@s.whatsapp.net",
      id: "ABCDEF123",
      fromMe: false,
      participant: "9999999999@s.whatsapp.net",
      senderPn: "9999999999:12@s.whatsapp.net",
      senderLid: "8888888888:3@lid",
      participantPn: "9999999999:12@s.whatsapp.net",
      participantLid: "8888888888:3@lid",
    };

    const result = normalizeMessageKey(key);

    expect(result.remoteJid).toBe("1234567890@s.whatsapp.net");
    expect(result.id).toBe("ABCDEF123");
    expect(result.fromMe).toBe(false);
    expect(result.participant).toBe("9999999999@s.whatsapp.net");
    expect(result.senderPn).toBe("9999999999:12@s.whatsapp.net");
    expect(result.senderLid).toBe("8888888888:3@lid");
    expect(result.participantPn).toBe("9999999999:12@s.whatsapp.net");
    expect(result.participantLid).toBe("8888888888:3@lid");
    expect(result.raw).toBe(key);
  });

  it("returns nulls for missing fields", () => {
    const key = {
      remoteJid: "group@g.us",
      // id missing
      // fromMe missing
      // participant missing
      // senderPn missing
      // senderLid missing
      // participantPn missing
      // participantLid missing
    };

    const result = normalizeMessageKey(key);

    expect(result.remoteJid).toBe("group@g.us");
    expect(result.id).toBeNull();
    expect(result.fromMe).toBeNull();
    expect(result.participant).toBeNull();
    expect(result.senderPn).toBeNull();
    expect(result.senderLid).toBeNull();
    expect(result.participantPn).toBeNull();
    expect(result.participantLid).toBeNull();
  });

  it("handles LID remoteJid + PN senderPn combo", () => {
    // Group message where remoteJid is a LID and senderPn carries the phone number.
    const key = {
      remoteJid: "12345:5@g.us",
      id: "MSG1",
      fromMe: false,
      participant: "lid:9999@s.whatsapp.net",
      senderPn: "9999999999:12@s.whatsapp.net",
      senderLid: "lid:9999@s.whatsapp.net",
    };

    const result = normalizeMessageKey(key);

    expect(result.remoteJid).toBe("12345:5@g.us");
    expect(result.senderPn).toBe("9999999999:12@s.whatsapp.net");
    expect(result.senderLid).toBe("lid:9999@s.whatsapp.net");
    expect(result.participant).toBe("lid:9999@s.whatsapp.net");
    expect(result.participantPn).toBeNull();
    expect(result.participantLid).toBeNull();
    expect(result.fromMe).toBe(false);
  });

  it("handles PN remoteJid + LID participant combo", () => {
    // Direct message where remoteJid is a phone JID and participant carries a LID.
    const key = {
      remoteJid: "5555555555@s.whatsapp.net",
      id: "MSG2",
      fromMe: true,
      participant: "lid:abc123@s.whatsapp.net",
      // senderPn absent — participant is the only sender identifier
    };

    const result = normalizeMessageKey(key);

    expect(result.remoteJid).toBe("5555555555@s.whatsapp.net");
    expect(result.participant).toBe("lid:abc123@s.whatsapp.net");
    expect(result.fromMe).toBe(true);
    expect(result.senderPn).toBeNull();
    expect(result.senderLid).toBeNull();
    expect(result.participantPn).toBeNull();
    expect(result.participantLid).toBeNull();
  });

  it("handles group message with participantPn + participantLid", () => {
    // Group message where Baileys provides both PN and LID for the participant.
    const key = {
      remoteJid: "120363000000000000@g.us",
      id: "MSG3",
      fromMe: false,
      participant: "7777777777@s.whatsapp.net",
      participantPn: "7777777777:0@s.whatsapp.net",
      participantLid: "6666666666:1@lid",
      senderPn: "7777777777:0@s.whatsapp.net",
      senderLid: "6666666666:1@lid",
    };

    const result = normalizeMessageKey(key);

    expect(result.participant).toBe("7777777777@s.whatsapp.net");
    expect(result.participantPn).toBe("7777777777:0@s.whatsapp.net");
    expect(result.participantLid).toBe("6666666666:1@lid");
    expect(result.senderPn).toBe("7777777777:0@s.whatsapp.net");
    expect(result.senderLid).toBe("6666666666:1@lid");
  });

  it("returns all-null normalized fields when key is null", () => {
    const result = normalizeMessageKey(null);

    expect(result.remoteJid).toBeNull();
    expect(result.id).toBeNull();
    expect(result.fromMe).toBeNull();
    expect(result.participant).toBeNull();
    expect(result.senderPn).toBeNull();
    expect(result.senderLid).toBeNull();
    expect(result.participantPn).toBeNull();
    expect(result.participantLid).toBeNull();
    expect(result.raw).toBeNull();
  });

  it("returns all-null normalized fields when key is undefined", () => {
    const result = normalizeMessageKey(undefined);

    expect(result.remoteJid).toBeNull();
    expect(result.id).toBeNull();
    expect(result.fromMe).toBeNull();
    expect(result.participant).toBeNull();
    expect(result.senderPn).toBeNull();
    expect(result.senderLid).toBeNull();
    expect(result.participantPn).toBeNull();
    expect(result.participantLid).toBeNull();
    expect(result.raw).toBeNull();
  });

  it("coerces non-string remoteJid to null", () => {
    const result = normalizeMessageKey({ remoteJid: 12345, id: "MSG" });
    expect(result.remoteJid).toBeNull();
    expect(result.id).toBe("MSG");
  });

  it("coerces non-boolean fromMe to null", () => {
    const result = normalizeMessageKey({ fromMe: "yes", id: "MSG" });
    expect(result.fromMe).toBeNull();
  });

  it("coerces non-string senderLid to null", () => {
    const result = normalizeMessageKey({ senderLid: 12345, id: "MSG" });
    expect(result.senderLid).toBeNull();
  });

  it("coerces non-string participantPn to null", () => {
    const result = normalizeMessageKey({ participantPn: true, id: "MSG" });
    expect(result.participantPn).toBeNull();
  });

  it("coerces non-string participantLid to null", () => {
    const result = normalizeMessageKey({ participantLid: {}, id: "MSG" });
    expect(result.participantLid).toBeNull();
  });

  it("preserves raw reference to original key object", () => {
    const key = { remoteJid: "test@s.whatsapp.net", id: "MSG" };
    const result = normalizeMessageKey(key);
    expect(result.raw).toBe(key);
    expect(result.raw).not.toBe(null);
  });
});
