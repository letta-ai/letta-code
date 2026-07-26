import { getChannelDisplayName } from "./plugin-registry";

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}

export function buildChannelContextUsageMessage(
  channelId: string,
  params: {
    usedTokens: number;
    contextWindow?: number | null;
    modelLabel: string;
    scope?: "agent" | "conversation";
  },
): string {
  if (params.usedTokens <= 0) {
    return "Context data is not available yet. Run a turn in this conversation, then try /context again.";
  }

  const displayName = channelDisplayName(channelId);
  const usedTokens = Math.floor(params.usedTokens);
  const contextWindow =
    typeof params.contextWindow === "number" && params.contextWindow > 0
      ? Math.floor(params.contextWindow)
      : null;
  const scopeText = params.scope ? ` (${params.scope})` : "";
  const lines = [`${displayName} context usage`];

  if (contextWindow) {
    const percentage = Math.min(
      100,
      Math.round((usedTokens / contextWindow) * 100),
    );
    const remainingTokens = Math.max(0, contextWindow - usedTokens);
    lines.push(
      `${formatTokenCount(usedTokens)} / ${formatTokenCount(contextWindow)} tokens used (${percentage}%).`,
      `${formatTokenCount(remainingTokens)} tokens remaining.`,
    );
  } else {
    lines.push(
      `${formatTokenCount(usedTokens)} tokens used.`,
      "Context window size is unknown.",
    );
  }

  lines.push(`Model: ${params.modelLabel}${scopeText}.`);
  return lines.join("\n");
}

export function buildChannelContextUnavailableMessage(
  channelId: string,
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} cannot use /context because the listener is not ready yet. Try again in a moment.`;
}

export function buildChannelContextFailedMessage(channelId: string): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} could not load context usage right now. Try again in a moment.`;
}
