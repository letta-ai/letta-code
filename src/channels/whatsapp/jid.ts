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

// ── Structured sender description ───────────────────────────────────

/**
 * Structured description of a WhatsApp sender JID.
 *
 * Unlike {@link senderIdFromJid} (which returns phone digits only and empty
 * string for LIDs), this gives callers enough information to handle both
 * PN and LID identities without losing data.
 *
 * Designed for incremental migration — callers that need LID awareness can
 * switch to this helper without changing existing `senderIdFromJid` callers.
 */
export type SenderIdDescription = {
  /** The original JID string, or empty string for null/undefined input. */
  raw: string;
  /**
   * Classification of the JID.
   * - `"pn"`: phone-number JID (`@s.whatsapp.net`)
   * - `"lid"`: linked-device identity JID (`@lid`)
   * - `"group"`: group JID (`@g.us`)
   * - `"broadcast"`: broadcast or newsletter JID (`@broadcast`, `@newsletter`)
   * - `"status"`: the special `status@broadcast` JID
   * - `"unknown"`: does not match any known suffix
   */
  type: "pn" | "lid" | "group" | "broadcast" | "status" | "unknown";
  /** Normalized phone digits (device suffix stripped). Empty if not a PN JID. */
  phoneDigits: string;
  /** Normalized LID JID (device suffix stripped). `null` if not a LID JID. */
  lidJid: string | null;
};

/**
 * Describe a WhatsApp sender JID as a structured object.
 *
 * Returns a {@link SenderIdDescription} with the JID classified and its
 * relevant identifier extracted. For null/undefined/empty input, returns
 * `{ raw: "", type: "unknown", phoneDigits: "", lidJid: null }`.
 */
export function describeSenderId(
  jid: string | null | undefined,
): SenderIdDescription {
  if (!jid) {
    return { raw: "", type: "unknown", phoneDigits: "", lidJid: null };
  }

  const normalized = stripDeviceSuffix(jid);

  // Check status@broadcast first (before the general broadcast check).
  if (normalized === "status@broadcast") {
    return { raw: jid, type: "status", phoneDigits: "", lidJid: null };
  }

  if (isGroupJid(normalized)) {
    return { raw: jid, type: "group", phoneDigits: "", lidJid: null };
  }

  // isStatusOrBroadcastJid covers @broadcast (non-status) and @newsletter.
  if (normalized.endsWith("@broadcast") || normalized.endsWith("@newsletter")) {
    return { raw: jid, type: "broadcast", phoneDigits: "", lidJid: null };
  }

  if (isPhoneJid(normalized)) {
    return {
      raw: jid,
      type: "pn",
      phoneDigits: jidToDigits(normalized),
      lidJid: null,
    };
  }

  if (isLidJid(normalized)) {
    return {
      raw: jid,
      type: "lid",
      phoneDigits: "",
      lidJid: normalized,
    };
  }

  return { raw: jid, type: "unknown", phoneDigits: "", lidJid: null };
}

// ── LidDesk-like interface ──────────────────────────────────────────

/**
 * Minimal LidDesk-like interface for alias resolution.
 * Avoids importing the full LidDesk class (keeps jid.ts cycle-free).
 */
export interface LidDeskLike {
  resolvePn(phoneJid: string): string | null;
  resolveLid(lidJid: string): string | null;
}

// ── allowedUsersIncludes (LID-aware) ───────────────────────────────

export function allowedUsersIncludes(
  allowedUsers: string[],
  senderId: string,
  desk?: LidDeskLike | null,
): boolean {
  const normalizedSender = normalizePhoneLike(senderId);

  // Fast path: direct digit comparison succeeds → done.
  if (
    normalizedSender &&
    allowedUsers.some((entry) => normalizePhoneLike(entry) === normalizedSender)
  ) {
    return true;
  }

  // No desk → can't resolve LID. Preserve original behavior (fail).
  if (!desk) {
    return allowedUsers.some(
      (entry) => normalizePhoneLike(entry) === normalizedSender,
    );
  }

  // --- LID-aware fallback ---
  // The senderId may be a LID JID, a phone JID, or raw digits.
  // Use describeSenderId to classify without losing information.
  const desc = describeSenderId(senderId);

  // Case 1: sender is a LID. Try resolving LID→phone via desk, then
  // compare digits. Also check whether the allowlist contains the LID
  // directly (strip-to-normalized form).
  if (desc.type === "lid" && desc.lidJid) {
    // Direct LID match: does the allowlist contain this LID?
    const lidMatch = allowedUsers.some(
      (entry) => stripDeviceSuffix(entry) === desc.lidJid,
    );
    if (lidMatch) return true;

    // Resolve LID→phone and retry digit comparison.
    const phoneJid = desk.resolveLid(desc.lidJid);
    if (phoneJid) {
      const phoneDigits = normalizePhoneLike(phoneJid);
      if (
        phoneDigits &&
        allowedUsers.some((entry) => normalizePhoneLike(entry) === phoneDigits)
      ) {
        return true;
      }
    }

    return false;
  }

  // Case 2: sender is a phone JID but digit extraction somehow failed
  // (shouldn't happen for valid PN JIDs, but guard anyway).
  // Case 3: sender is unknown type with no digits.
  // In both cases, fall through to original behavior (fail).
  return allowedUsers.some(
    (entry) => normalizePhoneLike(entry) === normalizedSender,
  );
}

// ── LID resolution helpers (v6-correct — no signalRepository.lidMapping) ──

export function resolveLidToPhoneJid(params: {
  lidJid: string;
  message?: unknown;
}): string | null {
  const { lidJid, message } = params;
  if (!isLidJid(lidJid)) return normalizeMaybePhoneJid(lidJid);

  // Baileys v6 message keys carry senderPn alongside LID routing.
  const msg = message as { key?: { senderPn?: string | null } } | undefined;
  const senderPn = normalizeMaybePhoneJid(msg?.key?.senderPn ?? undefined);
  if (senderPn) return senderPn;

  return null;
}

export function resolveSendJid(params: {
  chatId: string;
  selfPhoneJid?: string | null;
  selfLid?: string | null;
  lidToJid?: Map<string, string>;
}): string {
  const { chatId, selfPhoneJid, selfLid, lidToJid } = params;
  if (!isLidJid(chatId)) return stripDeviceSuffix(chatId);

  const normalized = stripDeviceSuffix(chatId);
  if (selfLid && normalized === stripDeviceSuffix(selfLid) && selfPhoneJid) {
    return stripDeviceSuffix(selfPhoneJid);
  }

  const mapped = normalizeMaybePhoneJid(lidToJid?.get(normalized));
  if (mapped) return mapped;

  throw new Error(`Cannot send to unresolved WhatsApp LID: ${chatId}`);
}

// ── Presence/typing LID resolution ──────────────────────────────────

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

// ── Alias and contact comparison ────────────────────────────────────

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
