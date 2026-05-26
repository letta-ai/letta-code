import { describe, expect, test } from "bun:test";
import {
  allowedUsersIncludes,
  isSelfChat,
  normalizeMaybePhoneJid,
  phoneDigitsToJid,
  resolveSendJid,
  stripDeviceSuffix,
} from "@/channels/whatsapp/jid";

describe("WhatsApp JID helpers", () => {
  test("strips device suffixes without changing the canonical JID", () => {
    expect(stripDeviceSuffix("15551234567:13@s.whatsapp.net")).toBe(
      "15551234567@s.whatsapp.net",
    );
    expect(stripDeviceSuffix("12345@g.us")).toBe("12345@g.us");
  });

  test("normalizes phone-like inputs", () => {
    expect(phoneDigitsToJid("+1 (555) 123-4567")).toBe(
      "15551234567@s.whatsapp.net",
    );
    expect(normalizeMaybePhoneJid("15551234567")).toBe(
      "15551234567@s.whatsapp.net",
    );
    expect(normalizeMaybePhoneJid("999@lid")).toBeNull();
  });

  test("detects self chat across phone JID and LID forms", () => {
    expect(
      isSelfChat(
        "15551234567@s.whatsapp.net",
        "15551234567@s.whatsapp.net",
        "abc@lid",
      ),
    ).toBe(true);
    expect(isSelfChat("abc@lid", "15551234567@s.whatsapp.net", "abc@lid")).toBe(
      true,
    );
    expect(
      isSelfChat(
        "other@s.whatsapp.net",
        "15551234567@s.whatsapp.net",
        "abc@lid",
      ),
    ).toBe(false);
  });

  test("matches allowlisted users by digits", () => {
    expect(allowedUsersIncludes(["+1 555 123 4567"], "15551234567")).toBe(true);
    expect(
      allowedUsersIncludes(["15551234567@s.whatsapp.net"], "+15551234567"),
    ).toBe(true);
  });

  test("refuses to send to unresolved LIDs", () => {
    expect(() => resolveSendJid({ chatId: "abc@lid" })).toThrow(/unresolved/i);
    expect(
      resolveSendJid({
        chatId: "abc@lid",
        lidToJid: new Map([["abc@lid", "15551234567@s.whatsapp.net"]]),
      }),
    ).toBe("15551234567@s.whatsapp.net");
  });
});
