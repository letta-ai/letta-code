import type {
  ChannelMessageAttachment,
  InboundChannelMessage,
  WhatsAppChannelAccount,
} from "@/channels/types";
import {
  canDownloadWhatsAppMedia,
  evaluateWhatsAppGroupAccess,
  evaluateWhatsAppSenderAccess,
  type WhatsAppGroupAccessReason,
  type WhatsAppSenderAccess,
} from "./access-gate";
import {
  discardWhatsAppAttachmentFiles,
  extractMentionedJids,
  extractReplyParticipant,
  extractWhatsAppText,
  hasWhatsAppMedia,
  isWhatsAppVoiceNote,
} from "./media";

const CHANNEL_ID = "whatsapp";

/**
 * Attachments collected for one inbound message.
 *
 * `transcriptionText` is only set for a transcribed voice note and is
 * already formatted for the agent ("[Voice message]: ...").
 */
export interface WhatsAppCollectedAttachments {
  attachments: ChannelMessageAttachment[];
  transcriptionText?: string;
}

/**
 * Why an inbound message never reached the agent.
 *
 * The group reasons mirror the group access decision; "empty" covers a
 * message that carried neither text nor an attachment.
 */
export type WhatsAppInboundDropReason = WhatsAppGroupAccessReason | "empty";

/**
 * Why the media of an inbound message was not downloaded.
 *
 * "sender_not_allowed" and "sender_not_paired" are the two outcomes the
 * registry acts on: the first drops the message, the second diverts it to
 * the pairing handshake. Neither may materialize files on disk.
 */
export type WhatsAppMediaSkipReason =
  | "sender_not_allowed"
  | "sender_not_paired";

export type WhatsAppInboundPreparation =
  | {
      kind: "deliver";
      body: string;
      attachments: ChannelMessageAttachment[];
      mediaSkipReason?: WhatsAppMediaSkipReason;
    }
  | { kind: "drop"; reason: WhatsAppInboundDropReason }
  | { kind: "abort" };

export interface WhatsAppInboundPrepareParams {
  account: WhatsAppChannelAccount;
  chatId: string;
  senderId: string;
  message: unknown;
  isGroup: boolean;
  selfPhoneJid: string | null;
  selfLid: string | null;
  /**
   * Collect the attachments of the message. `downloadMedia` is false when
   * the message may not materialize files on disk; the attachment
   * descriptors are still returned so the agent can see what arrived.
   */
  collectAttachments: (
    downloadMedia: boolean,
  ) => Promise<WhatsAppCollectedAttachments>;
  /** False once the connection that received the message went away. */
  isActive: () => boolean;
}

/**
 * Build the message the registry receives for a prepared inbound message.
 */
export function buildWhatsAppInboundMessage(params: {
  account: WhatsAppChannelAccount;
  chatId: string;
  senderId: string;
  senderName: string;
  chatLabel: string | undefined;
  text: string;
  timestamp: number;
  messageId: string;
  isGroup: boolean;
  attachments: ChannelMessageAttachment[];
  raw: unknown;
}): InboundChannelMessage {
  return {
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    chatId: params.chatId,
    senderId: params.senderId,
    senderName: params.senderName,
    chatLabel: params.chatLabel,
    text: params.text,
    timestamp: params.timestamp,
    messageId: params.messageId,
    chatType: params.isGroup ? "channel" : "direct",
    isMention: params.isGroup ? params.account.groupMode !== "open" : true,
    attachments: params.attachments.length > 0 ? params.attachments : undefined,
    raw: params.raw,
  };
}

/**
 * Gate an inbound message and collect its media.
 *
 * The order matters: the sender policy and the group policy are decided
 * before anything is downloaded, so a message the registry would drop
 * never leaves files behind on disk. The single exception is a voice note
 * in a group: it carries no text until it is transcribed, so the
 * transcript is the only way to tell whether the bot was addressed.
 */
export async function prepareWhatsAppInboundMessage(
  params: WhatsAppInboundPrepareParams,
): Promise<WhatsAppInboundPreparation> {
  const {
    account,
    chatId,
    senderId,
    message,
    isGroup,
    selfPhoneJid,
    selfLid,
    collectAttachments,
    isActive,
  } = params;

  const text = extractWhatsAppText(message);
  const wantsMedia = account.downloadMedia === true;
  const senderAccess = evaluateSenderAccess({
    account,
    senderId,
    isGroup,
    hasMedia: wantsMedia && hasWhatsAppMedia(message),
  });
  const mayDownloadMedia = canDownloadWhatsAppMedia(senderAccess);
  const mediaSkipReason = skipReasonForSenderAccess(senderAccess);

  let body = text;
  let attachments: ChannelMessageAttachment[] = [];
  let collected = false;

  if (isGroup) {
    const mentionedJids = extractMentionedJids(message);
    const replyParticipant = extractReplyParticipant(message);
    const decision = evaluateWhatsAppGroupAccess({
      account,
      groupJid: chatId,
      text: body,
      mentionedJids,
      replyParticipant,
      selfPhoneJid,
      selfLid,
    });
    if (!decision.allowed) {
      const canProbeTranscript =
        mayDownloadMedia &&
        wantsMedia &&
        account.transcribeVoice === true &&
        isWhatsAppVoiceNote(message);
      if (!canProbeTranscript) {
        return { kind: "drop", reason: decision.reason };
      }
      const probe = await collectAttachments(true);
      if (!isActive()) return { kind: "abort" };
      collected = true;
      attachments = probe.attachments;
      body = probe.transcriptionText || text;
      const recheck = evaluateWhatsAppGroupAccess({
        account,
        groupJid: chatId,
        text: body,
        mentionedJids,
        replyParticipant,
        selfPhoneJid,
        selfLid,
      });
      if (!recheck.allowed) {
        // The transcript did not address the bot either: the download was
        // only a probe, so remove the file it left behind.
        await discardWhatsAppAttachmentFiles(attachments);
        return { kind: "drop", reason: recheck.reason };
      }
    }
  }

  if (!collected) {
    const result = await collectAttachments(mayDownloadMedia && wantsMedia);
    if (!isActive()) return { kind: "abort" };
    attachments = result.attachments;
    body = result.transcriptionText || body;
  }

  if (!body.trim() && attachments.length === 0) {
    return { kind: "drop", reason: "empty" };
  }

  return {
    kind: "deliver",
    body,
    attachments,
    mediaSkipReason,
  };
}

/**
 * Only a message that actually carries media needs a sender decision:
 * without media there is nothing to download, and the registry applies
 * the same policy again before the message reaches the agent.
 */
function evaluateSenderAccess(params: {
  account: WhatsAppChannelAccount;
  senderId: string;
  isGroup: boolean;
  hasMedia: boolean;
}): WhatsAppSenderAccess {
  if (!params.hasMedia) return "allow";
  return evaluateWhatsAppSenderAccess({
    accountId: params.account.accountId,
    senderId: params.senderId,
    chatType: params.isGroup ? "channel" : "direct",
  });
}

function skipReasonForSenderAccess(
  access: WhatsAppSenderAccess,
): WhatsAppMediaSkipReason | undefined {
  if (access === "deny") return "sender_not_allowed";
  if (access === "pair") return "sender_not_paired";
  return undefined;
}
