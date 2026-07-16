/**
 * Normalized accessor for Baileys message key fields.
 *
 * In Baileys v6 the key shape is `{ remoteJid, id, fromMe, participant,
 * senderPn, senderLid, participantPn, participantLid }`. Baileys v7 may rename
 * or restructure these fields. By routing all field access through this single
 * accessor, the v7 migration becomes a one-file change.
 *
 * The accessor accepts a loosely-typed key (so the adapter's `WhatsAppMessage`
 * type does not need to change) and returns a normalized object with every
 * field the adapter reads, plus a `raw` reference for pass-through to Baileys
 * APIs that expect the original key shape.
 */

/** Fields the adapter reads from a Baileys message key. */
export interface NormalizedMessageKey {
  /** The chat/remote JID (e.g. `1234567890@s.whatsapp.net` or a group JID). */
  remoteJid: string | null;
  /** The unique message ID within the chat. */
  id: string | null;
  /** Whether the message was sent by the linked device (our own message). */
  fromMe: boolean | null;
  /** In groups: the JID of the sender. May be a LID or a phone JID. */
  participant: string | null;
  /** Sender phone-number JID, when available separately from participant. */
  senderPn: string | null;
  /** Sender LID JID, when available separately from participant. */
  senderLid: string | null;
  /** Participant phone-number JID (LID-routed groups). */
  participantPn: string | null;
  /** Participant LID JID (LID-routed groups). */
  participantLid: string | null;
  /**
   * The original key object, for pass-through to Baileys APIs (e.g. `chatModify`)
   * that expect the raw key shape. NOT for field access — use the typed fields
   * above instead.
   */
  raw: unknown;
}

/**
 * Accepts a Baileys message key (loosely typed) and returns a normalized
 * object with all fields the adapter reads.
 *
 * Returns `null` only when the input itself is null/undefined. Missing
 * individual fields within a non-null key are returned as `null`.
 */
export function normalizeMessageKey(key: unknown): NormalizedMessageKey {
  const k =
    key && typeof key === "object" ? (key as Record<string, unknown>) : null;

  if (!k) {
    return {
      remoteJid: null,
      id: null,
      fromMe: null,
      participant: null,
      senderPn: null,
      senderLid: null,
      participantPn: null,
      participantLid: null,
      raw: key ?? null,
    };
  }

  return {
    remoteJid: typeof k.remoteJid === "string" ? k.remoteJid : null,
    id: typeof k.id === "string" ? k.id : null,
    fromMe: typeof k.fromMe === "boolean" ? k.fromMe : null,
    participant: typeof k.participant === "string" ? k.participant : null,
    senderPn: typeof k.senderPn === "string" ? k.senderPn : null,
    senderLid: typeof k.senderLid === "string" ? k.senderLid : null,
    participantPn: typeof k.participantPn === "string" ? k.participantPn : null,
    participantLid:
      typeof k.participantLid === "string" ? k.participantLid : null,
    raw: key,
  };
}
