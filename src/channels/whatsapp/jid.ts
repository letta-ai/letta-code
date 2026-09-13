export const WHATSAPP_CHANNEL_ID = "whatsapp";
export const WHATSAPP_PHONE_SUFFIX = "@s.whatsapp.net";
export const WHATSAPP_LID_SUFFIX = "@lid";
export const WHATSAPP_GROUP_SUFFIX = "@g.us";

export function stripDeviceSuffix(jid: string | null | undefined): string {
  if (!jid) return "";
  return jid.replace(/:\d+(@|$)/, "$1");
}

export function isPhoneJid(jid: string | null | undefined): boolean {
  return !!jid && stripDeviceSuffix(jid).endsWith(WHATSAPP_PHONE_SUFFIX);
}

export function isLidJid(jid: string | null | undefined): boolean {
  return !!jid && stripDeviceSuffix(jid).endsWith(WHATSAPP_LID_SUFFIX);
}

export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && stripDeviceSuffix(jid).endsWith(WHATSAPP_GROUP_SUFFIX);
}

/**
 * Strict phone-JID check: suffix must be `@s.whatsapp.net` AND the localpart
 * (before `@`) must be all digits (device suffix `:N` allowed and stripped).
 *
 * Use this instead of {@link isPhoneJid} when accepting external/untrusted
 * input that could carry a non-numeric localpart (e.g. `garbage@s.whatsapp.net`).
 */
export function isStrictPhoneJid(jid: string | null | undefined): boolean {
  if (!jid) return false;
  const normalized = stripDeviceSuffix(jid);
  if (!normalized.endsWith(WHATSAPP_PHONE_SUFFIX)) return false;
  const localpart = normalized.slice(0, -WHATSAPP_PHONE_SUFFIX.length);
  return localpart.length > 0 && /^\d+$/.test(localpart);
}

/**
 * Strict LID-JID check: suffix must be `@lid` AND the localpart must be all
 * digits (device suffix `:N` allowed and stripped).
 *
 * Use this instead of {@link isLidJid} when accepting external/untrusted
 * input that could carry a non-numeric localpart.
 */
export function isStrictLidJid(jid: string | null | undefined): boolean {
  if (!jid) return false;
  const normalized = stripDeviceSuffix(jid);
  if (!normalized.endsWith(WHATSAPP_LID_SUFFIX)) return false;
  const localpart = normalized.slice(0, -WHATSAPP_LID_SUFFIX.length);
  return localpart.length > 0 && /^\d+$/.test(localpart);
}

export function isStatusOrBroadcastJid(
  jid: string | null | undefined,
): boolean {
  if (!jid) return true;
  const normalized = stripDeviceSuffix(jid);
  return (
    normalized === "status@broadcast" ||
    normalized.endsWith("@broadcast") ||
    normalized.endsWith("@newsletter")
  );
}

export function jidToDigits(jid: string | null | undefined): string {
  if (!jid) return "";
  const base = stripDeviceSuffix(jid).split("@")[0] ?? "";
  return base.replace(/\D/g, "");
}

export function normalizePhoneLike(value: string | null | undefined): string {
  if (!value) return "";
  return jidToDigits(value.trim());
}

export function phoneDigitsToJid(phoneDigits: string): string {
  const digits = normalizePhoneLike(phoneDigits);
  return digits ? `${digits}${WHATSAPP_PHONE_SUFFIX}` : "";
}

export function normalizeMaybePhoneJid(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isLidJid(trimmed)) return null;
  if (trimmed.includes("@")) return stripDeviceSuffix(trimmed);
  return phoneDigitsToJid(trimmed) || null;
}

export function isSelfChat(
  remoteJid: string | null | undefined,
  selfPhoneJid: string | null | undefined,
  selfLid: string | null | undefined,
): boolean {
  const remote = stripDeviceSuffix(remoteJid);
  if (!remote) return false;
  const phone = stripDeviceSuffix(selfPhoneJid);
  if (phone && remote === phone) return true;
  const lid = stripDeviceSuffix(selfLid);
  if (lid && remote === lid) return true;
  return false;
}

export function senderIdFromJid(jid: string | null | undefined): string {
  return jidToDigits(jid);
}

export function allowedUsersIncludes(
  allowedUsers: string[],
  senderId: string,
): boolean {
  const normalizedSender = normalizePhoneLike(senderId);
  return allowedUsers.some(
    (entry) => normalizePhoneLike(entry) === normalizedSender,
  );
}

export function resolveSendJid(params: {
  chatId: string;
  selfPhoneJid?: string | null;
  selfLid?: string | null;
  resolveLid?: (lidJid: string) => string | null;
}): string {
  const { chatId, selfPhoneJid, selfLid, resolveLid } = params;
  if (!isLidJid(chatId)) return stripDeviceSuffix(chatId);

  const normalized = stripDeviceSuffix(chatId);
  if (selfLid && normalized === stripDeviceSuffix(selfLid) && selfPhoneJid) {
    return stripDeviceSuffix(selfPhoneJid);
  }

  const mapped = resolveLid?.(normalized);
  if (mapped && isStrictPhoneJid(mapped)) {
    return stripDeviceSuffix(mapped);
  }

  throw new Error(`Cannot send to unresolved WhatsApp LID: ${chatId}`);
}

export function sanitizePathSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "whatsapp";
}
