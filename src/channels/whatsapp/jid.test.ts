import { describe, expect, test } from "bun:test";
import {
  allowedUsersIncludes,
  describeSenderId,
  type LidDeskLike,
  type SenderIdDescription,
  senderIdFromJid,
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

// ── allowedUsersIncludes (LID-aware) ────────────────────────────────

/** Minimal mock LidDesk for testing. */
function mockDesk(mapping: {
  lidToPn?: Record<string, string>;
  pnToLid?: Record<string, string>;
}): LidDeskLike {
  const lidToPn = mapping.lidToPn ?? {};
  const pnToLid = mapping.pnToLid ?? {};
  return {
    resolveLid(lidJid: string) {
      const normalized = lidJid.replace(/:\d+(@|$)/, "$1").split("@")[0] ?? "";
      const pn = lidToPn[normalized] ?? lidToPn[lidJid];
      return pn ?? null;
    },
    resolvePn(phoneJid: string) {
      const normalized =
        phoneJid.replace(/:\d+(@|$)/, "$1").split("@")[0] ?? "";
      const lid = pnToLid[normalized] ?? pnToLid[phoneJid];
      return lid ?? null;
    },
  };
}

describe("allowedUsersIncludes (LID-aware)", () => {
  test("phone sender matches phone allowlist entry (unchanged behavior)", () => {
    expect(
      allowedUsersIncludes(["1234567890@s.whatsapp.net"], "1234567890"),
    ).toBe(true);
    expect(
      allowedUsersIncludes(["1234567890"], "1234567890@s.whatsapp.net"),
    ).toBe(true);
    expect(allowedUsersIncludes(["9876543210"], "1234567890")).toBe(false);
  });

  test("phone sender matches without desk (backwards compatible)", () => {
    // No desk parameter — must work exactly as before.
    expect(
      allowedUsersIncludes(["1234567890@s.whatsapp.net"], "1234567890"),
    ).toBe(true);
    expect(
      allowedUsersIncludes(["1234567890"], "1234567890:5@s.whatsapp.net"),
    ).toBe(true);
    expect(allowedUsersIncludes(["111"], "222")).toBe(false);
  });

  test("LID sender with known LidDesk mapping matches phone allowlist entry", () => {
    const desk = mockDesk({
      lidToPn: { abc123: "1234567890@s.whatsapp.net" },
    });
    // Allowlist has the phone number, sender is the LID.
    expect(
      allowedUsersIncludes(["1234567890@s.whatsapp.net"], "abc123:5@lid", desk),
    ).toBe(true);
  });

  test("LID sender matches when allowlist has the LID directly", () => {
    const desk = mockDesk({
      lidToPn: { abc123: "1234567890@s.whatsapp.net" },
    });
    // Allowlist contains the LID JID itself.
    expect(allowedUsersIncludes(["abc123@lid"], "abc123:5@lid", desk)).toBe(
      true,
    );
  });

  test("LID sender with unknown LidDesk mapping fails (current behavior preserved)", () => {
    const desk = mockDesk({}); // no mapping
    expect(
      allowedUsersIncludes(["1234567890@s.whatsapp.net"], "abc123@lid", desk),
    ).toBe(false);
  });

  test("LID sender without desk fails (preserves original behavior)", () => {
    // No desk — LID produces empty digits, comparison fails.
    expect(allowedUsersIncludes(["1234567890"], "abc123@lid")).toBe(false);
  });

  test("LID sender with desk but phone not in allowlist fails", () => {
    const desk = mockDesk({
      lidToPn: { abc123: "1234567890@s.whatsapp.net" },
    });
    // Desk resolves LID→phone, but phone is NOT in allowlist.
    expect(
      allowedUsersIncludes(["9999999999@s.whatsapp.net"], "abc123@lid", desk),
    ).toBe(false);
  });

  test("phone sender with desk still matches normally (desk is transparent)", () => {
    const desk = mockDesk({
      lidToPn: { abc123: "1234567890@s.whatsapp.net" },
    });
    expect(
      allowedUsersIncludes(["1234567890"], "1234567890@s.whatsapp.net", desk),
    ).toBe(true);
  });

  test("null desk is equivalent to no desk (backwards compat)", () => {
    expect(allowedUsersIncludes(["1234567890"], "1234567890", null)).toBe(true);
    expect(allowedUsersIncludes(["1234567890"], "abc@lid", null)).toBe(false);
  });
});
