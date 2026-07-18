import {
  isLidJid,
  phoneDigitsToJid,
  resolveLidToPhoneJid,
  senderIdFromJid,
  stripDeviceSuffix,
} from "./jid";
import type { LidDesk } from "./lid-desk";

/**
 * Minimal structural type for the message shape consumed by
 * `resolveInboundChatId`. The WhatsApp adapter's `WhatsAppMessage`
 * type satisfies this without modification.
 */
export type InboundIdentityMessage = {
  key?: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
    senderPn?: string | null;
  };
};

/**
 * Closure-captured state that `resolveInboundChatId` needs from the
 * adapter runtime. Passed in via `createInboundChatIdResolver`.
 */
export type InboundIdentityContext = {
  /** The adapter's own phone JID, once known. */
  selfPhoneJid: string | null;
  /** The persistent LID↔PN mapping desk. */
  lidDesk: LidDesk;
};

/**
 * Resolve the canonical chat ID for an inbound WhatsApp message.
 *
 * Resolution order:
 * 1. Self-chat → return `selfPhoneJid` (or derive from remoteJid).
 * 2. LID remoteJid → check LidDesk, then fall back to runtime resolution
 *    (senderPn), recording any hit.
 * 3. Otherwise → strip device suffix and return.
 *
 * This is a pure extraction from `createWhatsAppAdapter`. The function
 * produces the same chatId for every input it saw before the move.
 */
export function resolveInboundChatId(
  ctx: InboundIdentityContext,
  remoteJid: string,
  selfChat: boolean,
  msg: InboundIdentityMessage,
): string {
  const normalizedRemote = stripDeviceSuffix(remoteJid);
  if (selfChat) {
    if (ctx.selfPhoneJid) return ctx.selfPhoneJid;
    const digits = senderIdFromJid(remoteJid);
    return phoneDigitsToJid(digits) || normalizedRemote;
  }
  if (isLidJid(normalizedRemote)) {
    // Check the desk first (includes persisted mappings from prior runs
    // and any just mined in the inbound loop).
    const deskResolved = ctx.lidDesk.resolveLid(normalizedRemote);
    if (deskResolved) return deskResolved;
    // Fall back to runtime resolution (senderPn).
    const resolved = resolveLidToPhoneJid({
      lidJid: normalizedRemote,
      message: msg,
    });
    if (resolved) {
      ctx.lidDesk.record(normalizedRemote, resolved);
      ctx.lidDesk.save();
      return resolved;
    }
  }
  return normalizedRemote;
}
