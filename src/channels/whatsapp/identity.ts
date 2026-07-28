/**
 * Canonical WhatsApp inbound identity resolver.
 *
 * Pure with respect to LidStore: only calls `store.resolve()`, never
 * `record()` or `flush()`. Returns validated `observedMappings` that the
 * caller may persist.
 */

import {
  isGroupJid,
  isStrictLidJid,
  isStrictPhoneJid,
  normalizePhoneLike,
  stripDeviceSuffix,
} from "@/channels/whatsapp/jid";
import type { LidStore } from "@/channels/whatsapp/lid-store";

export interface InboundTransport {
  selfPhoneJid?: string | null;
  selfLid?: string | null;
  remoteJid: string;
  participant?: string | null;
  senderPn?: string | null;
  participantPn?: string | null;
  participantLid?: string | null;
}

export interface ObservedMapping {
  lidJid: string;
  phoneJid: string;
}

export interface ResolvedIdentity {
  chatId: string;
  senderId: string;
  senderPhoneJid: string;
  observedMappings: ObservedMapping[];
}

// -- helpers --;

function toStrictPhoneJid(candidate: string | null | undefined): string | null {
  if (!candidate || !isStrictPhoneJid(candidate)) return null;
  return stripDeviceSuffix(candidate);
}

function make(
  chatId: string,
  phoneJid: string,
  observed: ObservedMapping[] = [],
): ResolvedIdentity {
  return {
    chatId,
    senderId: normalizePhoneLike(phoneJid),
    senderPhoneJid: phoneJid,
    observedMappings: observed,
  };
}

function resolveFromStore(
  lidJid: string,
  store: LidStore | null,
): string | null {
  if (!store) return null;
  const mapped = store.resolve(lidJid);
  if (mapped && isStrictPhoneJid(mapped)) return mapped;
  return null;
}

/**
 * Collect, normalize, and deduplicate supported paired LID→PN observations.
 * Reject if one LID claims multiple different PNs.
 * Compare against store; any conflict returns null.
 * Returns only observations whose LID is not already in the store.
 */
function collectObservations(
  transport: InboundTransport,
  store: LidStore | null,
): ObservedMapping[] | null {
  const { participant, participantPn, participantLid, senderPn } = transport;
  const validPnP = toStrictPhoneJid(participantPn);
  const validSenderPn = toStrictPhoneJid(senderPn);

  const rawPairs: Array<[string, string]> = [];
  if (participant && isStrictLidJid(participant)) {
    if (validPnP) rawPairs.push([participant, validPnP]);
    if (validSenderPn) rawPairs.push([participant, validSenderPn]);
  }
  if (participantLid && isStrictLidJid(participantLid)) {
    if (validPnP) rawPairs.push([participantLid, validPnP]);
  }

  if (rawPairs.length === 0) return [];

  const normalized = new Map<string, Set<string>>();
  for (const [lidJid, phoneJid] of rawPairs) {
    const key = stripDeviceSuffix(lidJid);
    let phoneSet = normalized.get(key);
    if (!phoneSet) {
      phoneSet = new Set<string>();
      normalized.set(key, phoneSet);
    }
    phoneSet.add(phoneJid);
  }

  // Reject if any LID maps to multiple different phones.
  for (const phones of normalized.values()) {
    if (phones.size > 1) return null;
  }

  const result: ObservedMapping[] = [];
  for (const [key, phones] of normalized) {
    const phoneValue = phones.values().next().value as string;
    // Check against store: conflict => reject entirely.
    if (store) {
      const existing = store.resolve(key);
      if (existing && existing !== phoneValue) return null;
      // Already mapped — no observation needed.
      if (existing) continue;
    }
    result.push({ lidJid: key, phoneJid: phoneValue });
  }

  return result;
}

// -- resolver --;

export function resolveInboundIdentity(
  transport: InboundTransport,
  store: LidStore | null = null,
): ResolvedIdentity | null {
  const { remoteJid } = transport;

  if (!isGroupJid(remoteJid)) return resolveDirect(transport, store);
  return resolveGroup(transport, store);
}

function resolveDirect(
  transport: InboundTransport,
  store: LidStore | null,
): ResolvedIdentity | null {
  const { selfPhoneJid, selfLid, remoteJid, senderPn } = transport;

  // Self-chat: phone-to-phone.
  if (
    isStrictPhoneJid(remoteJid) &&
    isStrictPhoneJid(selfPhoneJid) &&
    stripDeviceSuffix(remoteJid) === stripDeviceSuffix(selfPhoneJid)
  ) {
    const c = stripDeviceSuffix(selfPhoneJid);
    return make(c, c);
  }

  // Self-chat: LID-to-LID.
  if (
    isStrictLidJid(remoteJid) &&
    isStrictLidJid(selfLid) &&
    stripDeviceSuffix(remoteJid) === stripDeviceSuffix(selfLid) &&
    isStrictPhoneJid(selfPhoneJid)
  ) {
    const c = stripDeviceSuffix(selfPhoneJid);
    return make(c, c);
  }

  // Phone remoteJid.
  if (isStrictPhoneJid(remoteJid)) {
    const c = stripDeviceSuffix(remoteJid);
    return make(c, c);
  }

  // LID remoteJid.
  if (!isStrictLidJid(remoteJid)) return null;

  const validHint = toStrictPhoneJid(senderPn);
  const stored = resolveFromStore(remoteJid, store);

  // Existing conflicting mapping → fail closed.
  if (stored && validHint && validHint !== stored) return null;

  // Existing matching mapping → resolve as stored, no observation.
  if (stored) return make(stored, stored);

  // First-seen hint → resolve as hint, return observation.
  if (validHint) {
    return make(validHint, validHint, [
      { lidJid: stripDeviceSuffix(remoteJid), phoneJid: validHint },
    ]);
  }

  return null;
}

function resolveGroup(
  transport: InboundTransport,
  store: LidStore | null,
): ResolvedIdentity | null {
  const { remoteJid, participant, senderPn, participantPn, participantLid } =
    transport;
  const groupChatId = stripDeviceSuffix(remoteJid);

  // Collect observations (also validates internal consistency + store conflicts).
  const observations = collectObservations(transport, store);
  if (observations === null) return null;

  // Phase 1: direct phone-form candidates.
  for (const candidate of [participant, participantPn, senderPn]) {
    const canonical = toStrictPhoneJid(candidate);
    if (canonical) return make(groupChatId, canonical, observations);
  }

  // Phase 2: store lookup on LID participants.
  for (const lidCandidate of [participant, participantLid]) {
    if (lidCandidate && isStrictLidJid(lidCandidate)) {
      const phoneJid = resolveFromStore(lidCandidate, store);
      if (phoneJid) return make(groupChatId, phoneJid, observations);
    }
  }

  return null;
}
