import { describe, expect, test } from "bun:test";
import {
  describeSenderId,
  senderIdFromJid,
  type SenderIdDescription,
} from "./jid";

// ── describeSenderId ─────────────────────────────────────────────────

describe("describeSenderId", () => {
  test("PN JID: type 'pn' with phone digits, null lid", () => {
    const result = describeSenderId("1234567890@s.whatsapp.net");
    expect(result).toEqual({
      raw: "1234567890@s.whatsapp.net",
      type: "pn",
      phoneDigits: "1234567890",
      lidJid: null,
    });
  });

  test("PN JID with device suffix: strips device, extracts digits", () => {
    const result = describeSenderId("1234567890:7@s.whatsapp.net");
    expect(result.type).toBe("pn");
    expect(result.phoneDigits).toBe("1234567890");
    expect(result.lidJid).toBeNull();
    expect(result.raw).toBe("1234567890:7@s.whatsapp.net");
  });

  test("LID JID: type 'lid' with empty phone digits, lid present", () => {
    const result = describeSenderId("abc123:5@lid");
    expect(result).toEqual({
      raw: "abc123:5@lid",
      type: "lid",
      phoneDigits: "",
      lidJid: "abc123@lid",
    });
  });

  test("LID JID without device suffix", () => {
    const result = describeSenderId("xyz789@lid");
    expect(result.type).toBe("lid");
    expect(result.phoneDigits).toBe("");
    expect(result.lidJid).toBe("xyz789@lid");
  });

  test("group JID: type 'group'", () => {
    const result = describeSenderId("120363xxx@g.us");
    expect(result).toEqual({
      raw: "120363xxx@g.us",
      type: "group",
      phoneDigits: "",
      lidJid: null,
    });
  });

  test("status@broadcast: type 'status'", () => {
    const result = describeSenderId("status@broadcast");
    expect(result).toEqual({
      raw: "status@broadcast",
      type: "status",
      phoneDigits: "",
      lidJid: null,
    });
  });

  test("generic broadcast JID: type 'broadcast'", () => {
    const result = describeSenderId("12345@broadcast");
    expect(result).toEqual({
      raw: "12345@broadcast",
      type: "broadcast",
      phoneDigits: "",
      lidJid: null,
    });
  });

  test("newsletter JID: type 'broadcast'", () => {
    const result = describeSenderId("abc@newsletter");
    expect(result.type).toBe("broadcast");
    expect(result.raw).toBe("abc@newsletter");
  });

  test("unknown JID suffix: type 'unknown'", () => {
    const result = describeSenderId("foo@bar.com");
    expect(result).toEqual({
      raw: "foo@bar.com",
      type: "unknown",
      phoneDigits: "",
      lidJid: null,
    });
  });

  test("plain digits without suffix: type 'unknown'", () => {
    const result = describeSenderId("1234567890");
    expect(result.type).toBe("unknown");
    expect(result.phoneDigits).toBe("");
  });

  test("null input: type 'unknown', empty raw", () => {
    const result = describeSenderId(null);
    expect(result).toEqual({
      raw: "",
      type: "unknown",
      phoneDigits: "",
      lidJid: null,
    });
  });

  test("undefined input: type 'unknown', empty raw", () => {
    const result = describeSenderId(undefined);
    expect(result).toEqual({
      raw: "",
      type: "unknown",
      phoneDigits: "",
      lidJid: null,
    });
  });

  test("empty string input: type 'unknown', empty raw", () => {
    const result = describeSenderId("");
    expect(result).toEqual({
      raw: "",
      type: "unknown",
      phoneDigits: "",
      lidJid: null,
    });
  });

  test("satisfies SenderIdDescription type at compile time", () => {
    // Type assertion — if this compiles, the return type is correct.
    const result: SenderIdDescription = describeSenderId("123@s.whatsapp.net");
    expect(result.type).toBe("pn");
  });
});

// ── senderIdFromJid (regression — unchanged behavior) ────────────────

describe("senderIdFromJid (unchanged)", () => {
  test("PN JID returns digits", () => {
    expect(senderIdFromJid("1234567890@s.whatsapp.net")).toBe("1234567890");
  });

  test("PN JID with device suffix strips device", () => {
    expect(senderIdFromJid("1234567890:7@s.whatsapp.net")).toBe("1234567890");
  });

  test("LID JID returns empty string for non-numeric LID (known limitation)", () => {
    expect(senderIdFromJid("abc:5@lid")).toBe("");
  });

  test("null returns empty string", () => {
    expect(senderIdFromJid(null)).toBe("");
  });

  test("undefined returns empty string", () => {
    expect(senderIdFromJid(undefined)).toBe("");
  });
});
