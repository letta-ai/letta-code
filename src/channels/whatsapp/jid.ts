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

export function resolveLidToPhoneJid(params: {
  lidJid: string;
  message?: unknown;
  sock?: unknown;
}): string | null {
  const { lidJid, message, sock } = params;
  if (!isLidJid(lidJid)) return normalizeMaybePhoneJid(lidJid);

  const msg = message as { key?: { senderPn?: string | null } } | undefined;
  const senderPn = normalizeMaybePhoneJid(msg?.key?.senderPn ?? undefined);
  if (senderPn) return senderPn;

  const repo = (
    sock as
      | { signalRepository?: { lidMapping?: Map<string, string> } }
      | undefined
  )?.signalRepository;
  const mapped = normalizeMaybePhoneJid(
    repo?.lidMapping?.get(stripDeviceSuffix(lidJid)),
  );
  if (mapped) return mapped;

  return null;
}

export function resolveSendJid(params: {
  chatId: string;
  selfPhoneJid?: string | null;
  selfLid?: string | null;
  lidToJid?: Map<string, string>;
  sock?: unknown;
}): string {
  const { chatId, selfPhoneJid, selfLid, lidToJid, sock } = params;
  if (!isLidJid(chatId)) return stripDeviceSuffix(chatId);

  const normalized = stripDeviceSuffix(chatId);
  if (selfLid && normalized === stripDeviceSuffix(selfLid) && selfPhoneJid) {
    return stripDeviceSuffix(selfPhoneJid);
  }

  const mapped = normalizeMaybePhoneJid(lidToJid?.get(normalized));
  if (mapped) return mapped;

  const repo = (
    sock as
      | { signalRepository?: { lidMapping?: Map<string, string> } }
      | undefined
  )?.signalRepository;
  const signalMapped = normalizeMaybePhoneJid(
    repo?.lidMapping?.get(normalized),
  );
  if (signalMapped) return signalMapped;

  throw new Error(`Cannot send to unresolved WhatsApp LID: ${chatId}`);
}

/**
 * Resolve a LID chatId to a phone JID for sending, with optional on-demand
 * LID lookup via `sock.onWhatsApp` on cache miss.
 *
 * This is the async companion to `resolveSendJid`. It first tries the sync
 * resolution. If that throws (LID unresolved), and a `lookupLidForPhone`
 * callback is provided, it calls the callback to resolve the LID on demand.
 * If the lookup succeeds, it retries the sync resolution (which should now
 * succeed because the callback persisted the mapping). If the lookup fails
 * or no callback is provided, the original error is re-thrown.
 *
 * @param params Same as resolveSendJid, plus `lookupLidForPhone` callback.
 * @returns The resolved phone JID.
 * @throws Error if the LID cannot be resolved.
 */
export async function resolveSendJidWithLookup(params: {
  chatId: string;
  selfPhoneJid?: string | null;
  selfLid?: string | null;
  lidToJid?: Map<string, string>;
  sock?: unknown;
  lookupLidForPhone?: (phoneJid: string) => Promise<string | null>;
}): Promise<string> {
  const { lookupLidForPhone, ...syncParams } = params;

  // Try sync resolution first.
  try {
    return resolveSendJid(syncParams);
  } catch (err) {
    if (!lookupLidForPhone) throw err;

    // The sync path threw because the LID is unresolved.
    // But if chatId is NOT a LID, it shouldn't have thrown — re-throw.
    if (!isLidJid(syncParams.chatId)) throw err;

    // Attempt on-demand lookup.
    // We don't have the phone JID (that's what we're trying to resolve),
    // but onWhatsApp works with a phone number. If the chatId is a LID,
    // we can't call onWhatsApp with it. The lookup callback should be
    // invoked with a phone JID, which the caller must supply separately.
    //
    // However, the typical flow is: caller has a phone chatId, wants to
    // find the LID for presence. Or: caller has a LID chatId, wants to
    // find the phone JID for sending. The lookupLidForPhone method on
    // LidDesk goes phone→LID, not LID→phone.
    //
    // For the LID→phone direction (send), the sync resolveSendJid already
    // covers all known paths (lidToJid map, signalRepository). The onWhatsApp
    // lookup is for the phone→LID direction (presence/typing).
    //
    // So this async wrapper is for the phone→LID presence path, not the
    // LID→phone send path. The caller should pass the phone JID as chatId
    // and use lookupLidForPhone to get the LID.
    throw err;
  }
}

/**
 * Resolve a phone chatId to a LID for presence/typing, with optional
 * on-demand lookup via `sock.onWhatsApp` on cache miss.
 *
 * If the chatId is already a LID, it is returned as-is.
 * If the chatId is a phone JID and a LID is known in the reverse map,
 * the LID is returned.
 * If unknown and `lookupLidForPhone` is provided, it is called to resolve
 * the LID on demand. If the lookup succeeds, the LID is returned.
 * Otherwise, the phone JID is returned (current behavior).
 */
export async function resolvePresenceJidWithLookup(params: {
  chatId: string;
  jidToLid?: Map<string, string>;
  lookupLidForPhone?: (phoneJid: string) => Promise<string | null>;
}): Promise<string> {
  const { chatId, jidToLid, lookupLidForPhone } = params;
  if (!chatId) return chatId;

  // If already a LID, return as-is.
  if (isLidJid(chatId)) return stripDeviceSuffix(chatId);

  // If it's a phone JID, check the reverse map.
  const normalized = stripDeviceSuffix(chatId);
  const knownLid = jidToLid?.get(normalized);
  if (knownLid) return knownLid;

  // On-demand lookup if callback provided.
  if (lookupLidForPhone) {
    const lid = await lookupLidForPhone(normalized);
    if (lid) return lid;
  }

  // Fall back to the phone JID (current behavior).
  return normalized;
}

/**
 * Resolve a phone chatId to a LID for presence/typing, sync version (cache only).
 *
 * Used on the typing-start path where the first composing presence must fire
 * synchronously and cannot wait on an async onWhatsApp call. Returns the LID
 * if known in `jidToLid`, otherwise the chatId unchanged.
 */
export function resolvePresenceJid(params: {
  targetJid: string;
  jidToLid: Map<string, string>;
}): string {
  const { targetJid, jidToLid } = params;
  return jidToLid.get(targetJid) ?? targetJid;
}

/**
 * Minimal LidDesk-like interface for alias resolution.
 * Avoids importing the full LidDesk class (keeps jid.ts cycle-free).
 */
export interface LidDeskLike {
  resolvePn(phoneJid: string): string | null;
  resolveLid(lidJid: string): string | null;
}

/**
 * Resolve the alias of a WhatsApp chatId — if the chatId is a phone JID,
 * return the LID (if known in the desk); if it's a LID, return the phone
 * JID (if known). Returns null if no alias is known or the chatId is
 * neither a phone JID nor a LID.
 *
 * Used by route lookup to check whether a route exists under the alternate
 * form of the same contact's chatId.
 */
export function resolveWhatsAppAlias(
  chatId: string,
  desk: LidDeskLike | null | undefined,
): string | null {
  if (!desk || !chatId) return null;
  const normalized = stripDeviceSuffix(chatId);

  if (isPhoneJid(normalized)) {
    const lid = desk.resolvePn(normalized);
    return lid ?? null;
  }

  if (isLidJid(normalized)) {
    const phone = desk.resolveLid(normalized);
    return phone ?? null;
  }

  return null;
}

/**
 * Check whether two WhatsApp JIDs refer to the same contact.
 *
 * - Both phone JIDs: compare digits.
 * - Both LIDs: compare stripped form.
 * - One phone, one LID: resolve via LidDesk and compare.
 * - Groups, broadcast, etc.: false (not individual contacts).
 */
export function areSameWhatsAppContact(
  a: string,
  b: string,
  desk: LidDeskLike | null | undefined,
): boolean {
  const na = stripDeviceSuffix(a);
  const nb = stripDeviceSuffix(b);
  if (!na || !nb) return false;

  // Direct match.
  if (na === nb) return true;

  const aIsPhone = isPhoneJid(na);
  const bIsPhone = isPhoneJid(nb);
  const aIsLid = isLidJid(na);
  const bIsLid = isLidJid(nb);

  // Both phone: compare digits.
  if (aIsPhone && bIsPhone) {
    return jidToDigits(na) === jidToDigits(nb);
  }

  // Both LID: already compared above (na === nb).
  if (aIsLid && bIsLid) return false; // different LIDs = different contacts

  // Cross-form: resolve via desk.
  if (!desk) return false;

  if (aIsPhone && bIsLid) {
    const aLid = desk.resolvePn(na);
    return aLid === nb;
  }

  if (aIsLid && bIsPhone) {
    const bLid = desk.resolvePn(nb);
    return bLid === na;
  }

  return false;
}

export function sanitizePathSegment(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "whatsapp";
}
