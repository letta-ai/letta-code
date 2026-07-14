import type { SlackAllowBotsMode } from "@/channels/types";

export type SlackResolvedAllowBotsMode = "off" | "mentions" | "all";

export function isValidSlackAllowBotsConfigValue(
  value: unknown,
): value is SlackAllowBotsMode | "off" | "all" | undefined {
  return (
    value === undefined ||
    value === false ||
    value === true ||
    value === "off" ||
    value === "mentions" ||
    value === "all"
  );
}

export function normalizeSlackAllowBotsMode(
  value: unknown,
): SlackAllowBotsMode {
  if (value === true || value === "all") return true;
  if (value === "mentions") return "mentions";
  return false;
}

export function resolveSlackAllowBotsMode(
  value: SlackAllowBotsMode | undefined,
): SlackResolvedAllowBotsMode {
  if (value === true) return "all";
  if (value === "mentions") return "mentions";
  return "off";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type SlackBotPolicyMessage = {
  user?: unknown;
  bot_id?: unknown;
  subtype?: unknown;
};

export function isSlackBotAuthoredInboundMessage(
  message: SlackBotPolicyMessage,
): boolean {
  return isNonEmptyString(message.bot_id) || message.subtype === "bot_message";
}

export function isOwnSlackBotInboundMessage(params: {
  message: SlackBotPolicyMessage;
  botUserId: string | null;
  botId: string | null;
}): boolean {
  return (
    (isNonEmptyString(params.botUserId) &&
      params.message.user === params.botUserId) ||
    (isNonEmptyString(params.botId) && params.message.bot_id === params.botId)
  );
}

export function shouldAcceptSlackInboundBotMessage(params: {
  message: SlackBotPolicyMessage;
  allowBots: SlackAllowBotsMode | undefined;
  botUserId: string | null;
  botId: string | null;
  wasMentioned: boolean;
}): boolean {
  if (
    isOwnSlackBotInboundMessage({
      message: params.message,
      botUserId: params.botUserId,
      botId: params.botId,
    })
  ) {
    return false;
  }

  if (!isSlackBotAuthoredInboundMessage(params.message)) {
    return true;
  }

  // This is the loop-guard boundary Letta has today: suppress our own Slack
  // app identity and gate foreign bots at ingress. There is no shared
  // OpenClaw-style botLoopProtection state machine here.
  const mode = resolveSlackAllowBotsMode(params.allowBots);
  if (mode === "off") return false;
  if (mode === "mentions") return params.wasMentioned;
  return true;
}
