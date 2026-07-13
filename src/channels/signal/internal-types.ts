import type { ChannelTurnSource } from "@/channels/types";
import type { SignalRestClient } from "./client";

export type SignalClientLike = Pick<
  SignalRestClient,
  "check" | "sendMessage" | "sendReaction" | "sendTyping" | "streamEvents"
>;

export type SignalAdapterOptions = {
  client?: SignalClientLike;
  retryMs?: number;
};

export type SignalDataMessage = {
  timestamp?: number | null;
  message?: string | null;
  attachments?: Array<{
    id?: string | null;
    contentType?: string | null;
    filename?: string | null;
    storedFilename?: string | null;
    path?: string | null;
    localPath?: string | null;
    size?: number | null;
  }> | null;
  mentions?: Array<{
    name?: string | null;
    number?: string | null;
    uuid?: string | null;
  }> | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
  quote?: {
    text?: string | null;
    author?: string | null;
    authorUuid?: string | null;
  } | null;
  reaction?: SignalReactionMessage | null;
};

export type SignalReactionMessage = {
  emoji?: string | null;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  targetSentTimestamp?: number | null;
  isRemove?: boolean | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
};

export type SignalEnvelope = {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
  sourceName?: string | null;
  timestamp?: number | null;
  dataMessage?: SignalDataMessage | null;
  editMessage?: { dataMessage?: SignalDataMessage | null } | null;
  reactionMessage?: SignalReactionMessage | null;
  syncMessage?: SignalSyncMessage | null;
};

export type SignalSentSyncMessage = SignalDataMessage & {
  destination?: string | null;
  destinationNumber?: string | null;
  destinationUuid?: string | null;
  recipients?: string[] | null;
  timestamp?: number | null;
};

export type SignalSyncMessage = {
  sentMessage?: SignalSentSyncMessage | null;
};

export type SignalReceivePayload = {
  account?: string | null;
  envelope?: SignalEnvelope | null;
  exception?: { message?: string | null } | null;
};

export type SignalAttachmentCandidate = NonNullable<
  SignalDataMessage["attachments"]
>[number];

export type SignalTypingEntry = {
  source: ChannelTurnSource;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
};
