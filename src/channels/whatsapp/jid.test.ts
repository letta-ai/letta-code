import { describe, expect, test } from "bun:test";
import {
  allowedUsersIncludes,
  areSameWhatsAppContact,
  describeSenderId,
  type LidDeskLike,
  resolveLidToPhoneJid,
  resolvePresenceJid,
  resolvePresenceJidWithLookup,
  resolveSendJid,
  resolveWhatsAppAlias,
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

// ── resolveLidToPhoneJid (no signalRepository — v6-correct) ──────────

describe("resolveLidToPhoneJid (v6-correct, no lidMapping)", () => {
  test("non-LID JID passes through as phone JID", () => {
    const result = resolveLidToPhoneJid({
      lidJid: "1234567890@s.whatsapp.net",
    });
    expect(result).toBe("1234567890@s.whatsapp.net");
  });

  test("LID JID with senderPn resolves to phone JID", () => {
    const result = resolveLidToPhoneJid({
      lidJid: "abc123:5@lid",
      message: { key: { senderPn: "584149145006@s.whatsapp.net" } },
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("LID JID without senderPn returns null", () => {
    const result = resolveLidToPhoneJid({
      lidJid: "abc123:5@lid",
      message: { key: {} },
    });
    expect(result).toBeNull();
  });

  test("LID JID with no message returns null", () => {
    const result = resolveLidToPhoneJid({
      lidJid: "abc123:5@lid",
    });
    expect(result).toBeNull();
  });

  test("LID JID with null senderPn returns null", () => {
    const result = resolveLidToPhoneJid({
      lidJid: "abc123:5@lid",
      message: { key: { senderPn: null } },
    });
    expect(result).toBeNull();
  });
});

// ── resolveSendJid (no signalRepository — v6-correct) ────────────────

describe("resolveSendJid (v6-correct, no lidMapping)", () => {
  test("non-LID chatId passes through", () => {
    const result = resolveSendJid({
      chatId: "584149145006@s.whatsapp.net",
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("LID chatId resolves via lidToJid map", () => {
    const lidToJid = new Map([["555555@lid", "584149145006@s.whatsapp.net"]]);
    const result = resolveSendJid({
      chatId: "555555@lid",
      lidToJid,
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("self-LID resolves to self-phone", () => {
    const result = resolveSendJid({
      chatId: "mylid@lid",
      selfPhoneJid: "15551234567@s.whatsapp.net",
      selfLid: "mylid@lid",
    });
    expect(result).toBe("15551234567@s.whatsapp.net");
  });

  test("unresolved LID throws", () => {
    expect(() =>
      resolveSendJid({
        chatId: "unknown@lid",
      }),
    ).toThrow(/Cannot send to unresolved WhatsApp LID/);
  });
});

// ── resolvePresenceJid (sync) ───────────────────────────────────────

describe("resolvePresenceJid (sync)", () => {
  test("returns LID from jidToLid map when known", () => {
    const jidToLid = new Map([["584149145006@s.whatsapp.net", "42424242@lid"]]);
    const result = resolvePresenceJid({
      targetJid: "584149145006@s.whatsapp.net",
      jidToLid,
    });
    expect(result).toBe("42424242@lid");
  });

  test("returns targetJid unchanged when LID unknown", () => {
    const jidToLid = new Map();
    const result = resolvePresenceJid({
      targetJid: "584149145006@s.whatsapp.net",
      jidToLid,
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("returns targetJid unchanged for empty map", () => {
    const result = resolvePresenceJid({
      targetJid: "584149145006@s.whatsapp.net",
      jidToLid: new Map(),
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });
});

// ── resolvePresenceJidWithLookup (async) ────────────────────────────

describe("resolvePresenceJidWithLookup (async)", () => {
  test("returns LID as-is when chatId is already a LID", async () => {
    const result = await resolvePresenceJidWithLookup({
      chatId: "42424242@lid",
    });
    expect(result).toBe("42424242@lid");
  });

  test("returns LID from jidToLid map when known", async () => {
    const jidToLid = new Map([["584149145006@s.whatsapp.net", "42424242@lid"]]);
    const result = await resolvePresenceJidWithLookup({
      chatId: "584149145006@s.whatsapp.net",
      jidToLid,
    });
    expect(result).toBe("42424242@lid");
  });

  test("calls lookupLidForPhone on cache miss", async () => {
    let calledWith = "";
    const result = await resolvePresenceJidWithLookup({
      chatId: "584149145006@s.whatsapp.net",
      lookupLidForPhone: async (phoneJid) => {
        calledWith = phoneJid;
        return "99999999@lid";
      },
    });
    expect(calledWith).toBe("584149145006@s.whatsapp.net");
    expect(result).toBe("99999999@lid");
  });

  test("falls back to phone JID when lookup returns null", async () => {
    const result = await resolvePresenceJidWithLookup({
      chatId: "584149145006@s.whatsapp.net",
      lookupLidForPhone: async () => null,
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("falls back to phone JID when no lookup callback", async () => {
    const result = await resolvePresenceJidWithLookup({
      chatId: "584149145006@s.whatsapp.net",
    });
    expect(result).toBe("584149145006@s.whatsapp.net");
  });

  test("empty chatId returns empty string", async () => {
    const result = await resolvePresenceJidWithLookup({
      chatId: "",
    });
    expect(result).toBe("");
  });
});

// ── resolveWhatsAppAlias ────────────────────────────────────────────

describe("resolveWhatsAppAlias", () => {
  test("phone JID resolves to LID via desk.resolvePn", () => {
    const desk = mockDesk({
      pnToLid: { "1234567890": "abc123@lid" },
    });
    const result = resolveWhatsAppAlias("1234567890@s.whatsapp.net", desk);
    expect(result).toBe("abc123@lid");
  });

  test("LID resolves to phone JID via desk.resolveLid", () => {
    const desk = mockDesk({
      lidToPn: { abc123: "1234567890@s.whatsapp.net" },
    });
    const result = resolveWhatsAppAlias("abc123@lid", desk);
    expect(result).toBe("1234567890@s.whatsapp.net");
  });

  test("returns null when desk has no mapping", () => {
    const desk = mockDesk({});
    expect(resolveWhatsAppAlias("1234567890@s.whatsapp.net", desk)).toBeNull();
    expect(resolveWhatsAppAlias("abc123@lid", desk)).toBeNull();
  });

  test("returns null when no desk provided", () => {
    expect(resolveWhatsAppAlias("1234567890@s.whatsapp.net", null)).toBeNull();
    expect(
      resolveWhatsAppAlias("1234567890@s.whatsapp.net", undefined),
    ).toBeNull();
  });

  test("returns null for empty chatId", () => {
    expect(resolveWhatsAppAlias("", mockDesk({}))).toBeNull();
  });

  test("returns null for group JID (not a contact)", () => {
    expect(resolveWhatsAppAlias("group@g.us", mockDesk({}))).toBeNull();
  });
});

// ── areSameWhatsAppContact ──────────────────────────────────────────

describe("areSameWhatsAppContact", () => {
  test("identical phone JIDs match", () => {
    expect(
      areSameWhatsAppContact(
        "1234567890@s.whatsapp.net",
        "1234567890@s.whatsapp.net",
        null,
      ),
    ).toBe(true);
  });

  test("phone JIDs with same digits but different device suffix match", () => {
    expect(
      areSameWhatsAppContact(
        "1234567890:5@s.whatsapp.net",
        "1234567890:7@s.whatsapp.net",
        null,
      ),
    ).toBe(true);
  });

  test("different phone JIDs do not match", () => {
    expect(
      areSameWhatsAppContact(
        "1234567890@s.whatsapp.net",
        "9876543210@s.whatsapp.net",
        null,
      ),
    ).toBe(false);
  });

  test("identical LIDs match", () => {
    expect(areSameWhatsAppContact("abc123@lid", "abc123@lid", null)).toBe(true);
  });

  test("different LIDs do not match", () => {
    expect(areSameWhatsAppContact("abc123@lid", "xyz789@lid", null)).toBe(
      false,
    );
  });

  test("phone and LID match via desk (phone→lid)", () => {
    const desk = mockDesk({
      pnToLid: { "1234567890": "abc123@lid" },
    });
    expect(
      areSameWhatsAppContact("1234567890@s.whatsapp.net", "abc123@lid", desk),
    ).toBe(true);
  });

  test("phone and LID match via desk (lid→phone direction)", () => {
    const desk = mockDesk({
      pnToLid: { "1234567890": "abc123@lid" },
    });
    expect(
      areSameWhatsAppContact("abc123@lid", "1234567890@s.whatsapp.net", desk),
    ).toBe(true);
  });

  test("phone and LID without desk do not match", () => {
    expect(
      areSameWhatsAppContact("1234567890@s.whatsapp.net", "abc123@lid", null),
    ).toBe(false);
  });

  test("empty JIDs do not match", () => {
    expect(areSameWhatsAppContact("", "abc123@lid", null)).toBe(false);
    expect(areSameWhatsAppContact("", "", null)).toBe(false);
  });
});
