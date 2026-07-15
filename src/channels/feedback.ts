import { submitFeedbackMetadata } from "@/backend/api/metadata";
import { settingsManager } from "@/settings-manager";
import { getVersion } from "@/version";
import { getChannelDisplayName } from "./plugin-registry";
import type { ChannelRoute, InboundChannelMessage } from "./types";

export const CHANNEL_FEEDBACK_MESSAGE_MAX = 10_000;

const CHANNEL_FEEDBACK_FEATURE = "letta-code-channel-feedback";

export interface ChannelFeedbackSubmission {
  message: string;
  channel: string;
  accountId?: string;
  agentId: string;
  conversationId: string;
}

export type ChannelFeedbackMetadataSubmitter = (
  payload: Record<string, unknown>,
) => Promise<void>;

let submitOverride: ChannelFeedbackMetadataSubmitter | null = null;

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

function feedbackCommandUsage(channelId: string): string {
  return channelId === "slack"
    ? "@agent /feedback <message>"
    : "/feedback <message>";
}

export function buildChannelFeedbackUsageMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return [
    `${displayName} received /feedback without a message.`,
    `Usage: ${feedbackCommandUsage(channelId)}`,
  ].join("\n\n");
}

export function buildChannelFeedbackTooLongMessage(
  channelId: string,
  maxLength: number = CHANNEL_FEEDBACK_MESSAGE_MAX,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} feedback message is too long. Maximum is ${maxLength.toLocaleString()} characters.`;
}

export function buildChannelFeedbackNoRouteMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  const instruction =
    channelId === "slack"
      ? `Mention the app with a normal message in this chat or thread first so it can connect, then try ${feedbackCommandUsage(channelId)}.`
      : `Send a normal message first and follow the pairing instructions, then try ${feedbackCommandUsage(channelId)}.`;
  return [
    `${displayName} cannot submit /feedback until this chat is connected to a Letta agent conversation.`,
    instruction,
  ].join("\n\n");
}

export function buildChannelFeedbackSubmittedMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} feedback submitted. Thanks for helping improve Letta Code.`;
}

export function buildChannelFeedbackFailedMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} could not submit feedback right now. Please try again later.`;
}

function withDefinedValues(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

export function buildChannelFeedbackPayload(
  submission: ChannelFeedbackSubmission,
): Record<string, unknown> {
  return withDefinedValues({
    message: submission.message,
    feature: CHANNEL_FEEDBACK_FEATURE,
    version: getVersion(),
    platform: process.platform,
    channel: submission.channel,
    account_id: submission.accountId,
    agent_id: submission.agentId,
    conversation_id: submission.conversationId,
  });
}

export async function submitChannelFeedback(
  submission: ChannelFeedbackSubmission,
): Promise<void> {
  const payload = buildChannelFeedbackPayload(submission);
  if (submitOverride) {
    await submitOverride(payload);
    return;
  }

  const settings = settingsManager.getSettings();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
  await submitFeedbackMetadata(
    apiKey,
    settingsManager.getOrCreateDeviceId(),
    payload,
  );
}

export async function handleChannelFeedbackCommand(params: {
  msg: InboundChannelMessage;
  command: { args: string };
  route?: ChannelRoute | null;
}): Promise<string> {
  const message = params.command.args.trim();
  if (!message) {
    return buildChannelFeedbackUsageMessage(params.msg.channel);
  }
  if (message.length > CHANNEL_FEEDBACK_MESSAGE_MAX) {
    return buildChannelFeedbackTooLongMessage(params.msg.channel);
  }

  const route = params.route;
  if (!route || route.enabled === false) {
    return buildChannelFeedbackNoRouteMessage(params.msg.channel);
  }

  try {
    const accountId = route.accountId ?? params.msg.accountId;
    await submitChannelFeedback({
      message,
      channel: params.msg.channel,
      ...(accountId !== undefined ? { accountId } : {}),
      agentId: route.agentId,
      conversationId: route.conversationId,
    });
    return buildChannelFeedbackSubmittedMessage(params.msg.channel);
  } catch {
    return buildChannelFeedbackFailedMessage(params.msg.channel);
  }
}

export function __testOverrideSubmitChannelFeedback(
  submitter: ChannelFeedbackMetadataSubmitter | null,
): void {
  submitOverride = submitter;
}
