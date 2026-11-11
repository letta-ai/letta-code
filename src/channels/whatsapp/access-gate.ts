import { evaluateChannelSenderAccess } from "@/channels/access-control";
import { getChannelAccount } from "@/channels/accounts";
import type { ChannelChatType, WhatsAppChannelAccount } from "@/channels/types";
import { stripDeviceSuffix } from "./jid";

const CHANNEL_ID = "whatsapp";

const MAX_MENTION_PATTERN_LENGTH = 256;
const MENTION_MATCH_TEXT_MAX_LENGTH = 2000;

/**
 * Sender access decision for an inbound WhatsApp message.
 *
 * - "allow": the sender may reach the agent.
 * - "deny": the sender is outside the allowlist; the registry drops the
 *   message.
 * - "pair": the sender still has to pair; direct messages are diverted to
 *   the pairing handshake instead of the agent.
 * - "unrestricted": no account is registered for the channel, so the
 *   registry cannot gate the message either.
 */
export type WhatsAppSenderAccess = "allow" | "deny" | "pair" | "unrestricted";

/**
 * Evaluate the same sender policy the channel registry applies, before any
 * inbound media is downloaded.
 *
 * The registered account is read from the account store (not from the
 * adapter's startup snapshot) so this stays in sync with the configuration
 * the registry enforces. A missing account mirrors the registry, which
 * cannot gate messages it has no configuration for.
 */
export function evaluateWhatsAppSenderAccess(params: {
  accountId: string;
  senderId: string;
  chatType: ChannelChatType;
}): WhatsAppSenderAccess {
  const account = getChannelAccount(CHANNEL_ID, params.accountId);
  if (!account) return "unrestricted";
  const decision = evaluateChannelSenderAccess({
    account,
    channelId: CHANNEL_ID,
    senderId: params.senderId,
    chatType: params.chatType,
  });
  return decision;
}

/**
 * Only an allowed sender can have its media downloaded: a denied sender's
 * message is dropped by the registry, and a sender that still has to pair
 * only receives pairing instructions. When no account is registered the
 * registry cannot gate the message either, so downloads proceed as before.
 */
export function canDownloadWhatsAppMedia(
  access: WhatsAppSenderAccess,
): boolean {
  return access === "allow" || access === "unrestricted";
}

/**
 * Why a group message was (or was not) addressed to the bot.
 *
 * "not_addressed" is the only rejecting reason that a transcript can
 * still flip: a voice note carries no text until it is transcribed.
 */
export type WhatsAppGroupAccessReason =
  | "group_disabled"
  | "group_not_allowed"
  | "not_addressed"
  | "open_group"
  | "mention"
  | "reply"
  | "mention_pattern";

export interface WhatsAppGroupAccessDecision {
  allowed: boolean;
  reason: WhatsAppGroupAccessReason;
}

function matchesSelf(
  jid: string,
  selfPhoneJid: string | null,
  selfLid: string | null,
): boolean {
  const normalized = stripDeviceSuffix(jid);
  return (
    (!!selfPhoneJid && normalized === stripDeviceSuffix(selfPhoneJid)) ||
    (!!selfLid && normalized === stripDeviceSuffix(selfLid))
  );
}

/**
 * Decide whether a group message is addressed to the bot.
 *
 * The reason is returned (not just a boolean) so the caller can tell a
 * group that is switched off from a group where the bot was simply not
 * addressed, and so a transcript can re-run the decision once the voice
 * note has been transcribed.
 */
export function evaluateWhatsAppGroupAccess(params: {
  account: WhatsAppChannelAccount;
  groupJid: string;
  text: string;
  mentionedJids: string[];
  replyParticipant: string | null;
  selfPhoneJid: string | null;
  selfLid: string | null;
}): WhatsAppGroupAccessDecision {
  const {
    account,
    groupJid,
    text,
    mentionedJids,
    replyParticipant,
    selfPhoneJid,
    selfLid,
  } = params;
  if (account.groupMode === "disabled") {
    return { allowed: false, reason: "group_disabled" };
  }
  if (
    account.allowedGroups?.length &&
    !account.allowedGroups.includes(groupJid)
  ) {
    return { allowed: false, reason: "group_not_allowed" };
  }
  if (account.groupMode === "open") {
    return { allowed: true, reason: "open_group" };
  }
  if (mentionedJids.some((jid) => matchesSelf(jid, selfPhoneJid, selfLid))) {
    return { allowed: true, reason: "mention" };
  }
  if (
    replyParticipant &&
    matchesSelf(replyParticipant, selfPhoneJid, selfLid)
  ) {
    return { allowed: true, reason: "reply" };
  }
  const matchText = text.slice(0, MENTION_MATCH_TEXT_MAX_LENGTH);
  for (const pattern of account.mentionPatterns ?? []) {
    if (pattern.length > MAX_MENTION_PATTERN_LENGTH) continue;
    try {
      if (new RegExp(pattern, "i").test(matchText)) {
        return { allowed: true, reason: "mention_pattern" };
      }
    } catch {
      // Ignore invalid user-provided patterns.
    }
  }
  return { allowed: false, reason: "not_addressed" };
}
