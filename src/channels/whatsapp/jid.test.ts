import { describe, expect, test } from "bun:test";

import {
  isStrictLidJid,
  isStrictPhoneJid,
  WHATSAPP_LID_SUFFIX,
  WHATSAPP_PHONE_SUFFIX,
} from "@/channels/whatsapp/jid";

const P = WHATSAPP_PHONE_SUFFIX;
const L = WHATSAPP_LID_SUFFIX;

describe("isStrictPhoneJid", () => {
  test("valid phone JID", () => {
    expect(isStrictPhoneJid(`58414111111${P}`)).toBe(true);
  });

  test("valid phone JID with device suffix", () => {
    expect(isStrictPhoneJid(`58414111111:5${P}`)).toBe(true);
  });

  test("rejects non-numeric localpart", () => {
    expect(isStrictPhoneJid(`garbage${P}`)).toBe(false);
  });

  test("rejects LID JID", () => {
    expect(isStrictPhoneJid(`123456${L}`)).toBe(false);
  });

  test("rejects bare digits", () => {
    expect(isStrictPhoneJid("58414111111")).toBe(false);
  });

  test("rejects empty/null/undefined", () => {
    expect(isStrictPhoneJid("")).toBe(false);
    expect(isStrictPhoneJid(null)).toBe(false);
    expect(isStrictPhoneJid(undefined)).toBe(false);
  });
});

describe("isStrictLidJid", () => {
  test("valid LID JID", () => {
    expect(isStrictLidJid(`123456789${L}`)).toBe(true);
  });

  test("valid LID JID with device suffix", () => {
    expect(isStrictLidJid(`123456789:3${L}`)).toBe(true);
  });

  test("rejects non-numeric localpart", () => {
    expect(isStrictLidJid(`garbage${L}`)).toBe(false);
  });

  test("rejects phone JID", () => {
    expect(isStrictLidJid(`58414111111${P}`)).toBe(false);
  });

  test("rejects empty/null/undefined", () => {
    expect(isStrictLidJid("")).toBe(false);
    expect(isStrictLidJid(null)).toBe(false);
  });
});
