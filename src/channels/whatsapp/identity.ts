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
  senderLid?: string | null;
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
  observedMappings: ObservedMapping[];
}

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
    observedMappings: observed,
  };
}

function resolveFromStore(
  lidJid: string,
  store: LidStore | null,
): string | null {
  if (!store) return null;
  const mapped = store.resolve(lidJid);
  return toStrictPhoneJid(mapped);
}

function collectCandidates(
  transport: InboundTransport,
  direct: boolean,
): { lids: string[]; phones: string[] } {
  const lids: string[] = [];
  const phones: string[] = [];
  const addLid = (candidate: string | null | undefined) => {
    if (candidate && isStrictLidJid(candidate)) {
      const normalized = stripDeviceSuffix(candidate);
      if (!lids.includes(normalized)) lids.push(normalized);
    }
  };
  const addPhone = (candidate: string | null | undefined) => {
    const normalized = toStrictPhoneJid(candidate);
    if (normalized && !phones.includes(normalized)) phones.push(normalized);
  };

  if (direct) {
    addLid(transport.remoteJid);
    addLid(transport.senderLid);
    addPhone(transport.remoteJid);
    addPhone(transport.senderPn);
  } else {
    addLid(transport.participant);
    addLid(transport.participantLid);
    addLid(transport.senderLid);
    addPhone(transport.participant);
    addPhone(transport.participantPn);
    addPhone(transport.senderPn);
  }

  return { lids, phones };
}

function resolveCandidates(
  lids: string[],
  phones: string[],
  store: LidStore | null,
): { phoneJid: string; observedMappings: ObservedMapping[] } | null {
  if (phones.length > 1) return null;

  let phoneJid = phones[0] ?? null;
  const storedMappings = new Map<string, string>();
  for (const lidJid of lids) {
    const stored = resolveFromStore(lidJid, store);
    if (!stored) continue;
    storedMappings.set(lidJid, stored);
    if (phoneJid && phoneJid !== stored) return null;
    phoneJid ??= stored;
  }
  if (!phoneJid) return null;

  const observedMappings: ObservedMapping[] = [];
  for (const lidJid of lids) {
    if (!storedMappings.has(lidJid)) {
      observedMappings.push({ lidJid, phoneJid });
    }
  }
  return { phoneJid, observedMappings };
}

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
  const { selfPhoneJid, selfLid, remoteJid } = transport;

  if (
    isStrictPhoneJid(remoteJid) &&
    isStrictPhoneJid(selfPhoneJid) &&
    stripDeviceSuffix(remoteJid) === stripDeviceSuffix(selfPhoneJid)
  ) {
    const c = stripDeviceSuffix(selfPhoneJid);
    return make(c, c);
  }

  if (
    isStrictLidJid(remoteJid) &&
    isStrictLidJid(selfLid) &&
    stripDeviceSuffix(remoteJid) === stripDeviceSuffix(selfLid) &&
    isStrictPhoneJid(selfPhoneJid)
  ) {
    const c = stripDeviceSuffix(selfPhoneJid);
    return make(c, c);
  }

  const candidates = collectCandidates(transport, true);
  const resolved = resolveCandidates(candidates.lids, candidates.phones, store);
  if (!resolved) return null;
  return make(resolved.phoneJid, resolved.phoneJid, resolved.observedMappings);
}

function resolveGroup(
  transport: InboundTransport,
  store: LidStore | null,
): ResolvedIdentity | null {
  const { remoteJid } = transport;
  const groupChatId = stripDeviceSuffix(remoteJid);
  const candidates = collectCandidates(transport, false);
  const resolved = resolveCandidates(candidates.lids, candidates.phones, store);
  if (!resolved) return null;
  return make(groupChatId, resolved.phoneJid, resolved.observedMappings);
}
