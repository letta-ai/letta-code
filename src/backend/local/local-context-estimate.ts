import type { Usage } from "@earendil-works/pi-ai";
import type { LocalMessage } from "./local-message";

const IMAGE_TOKEN_ESTIMATE = 1200;

export interface LocalContextTokenEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

function positiveUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function contextTokensFromLocalUsage(usage: Usage): number | undefined {
  const totalTokens = positiveUsageNumber(usage.totalTokens);
  if (totalTokens !== undefined) return totalTokens;

  const inputTokens = typeof usage.input === "number" ? usage.input : undefined;
  const outputTokens =
    typeof usage.output === "number" ? usage.output : undefined;
  const cacheRead =
    typeof usage.cacheRead === "number" ? usage.cacheRead : undefined;
  const cacheWrite =
    typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined;
  if (
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cacheRead !== undefined ||
    cacheWrite !== undefined
  ) {
    const contextTokens =
      (inputTokens ?? 0) +
      (outputTokens ?? 0) +
      (cacheRead ?? 0) +
      (cacheWrite ?? 0);
    if (contextTokens > 0) return contextTokens;
  }
  return undefined;
}

function textLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export function estimateLocalMessageTokens(message: LocalMessage): number {
  let chars = 0;

  if (message.role === "user") {
    if (typeof message.content === "string") {
      chars = message.content.length;
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          chars += textLength(block.text);
        } else if (block.type === "image") {
          chars += IMAGE_TOKEN_ESTIMATE * 4;
        }
      }
    }
    return Math.ceil(chars / 4);
  }

  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") {
        chars += textLength(block.text);
      } else if (block.type === "thinking") {
        chars += textLength(block.thinking);
      } else if (block.type === "toolCall") {
        chars += textLength(block.name) + jsonLength(block.arguments);
      }
    }
    return Math.ceil(chars / 4);
  }

  for (const block of message.content) {
    if (block.type === "text") {
      chars += textLength(block.text);
    } else if (block.type === "image") {
      chars += IMAGE_TOKEN_ESTIMATE * 4;
    }
  }
  return Math.ceil(chars / 4);
}

function latestCompactionBoundaryTimestamp(
  messages: readonly LocalMessage[],
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.metadata?.compaction) return message.timestamp;
  }
  return undefined;
}

function getAssistantUsageInfo(
  messages: readonly LocalMessage[],
  staleAtOrBefore?: number,
): { usage: Usage; index: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") {
      continue;
    }
    if (staleAtOrBefore !== undefined && message.timestamp <= staleAtOrBefore) {
      continue;
    }
    const usageTokens = contextTokensFromLocalUsage(message.usage);
    if (usageTokens !== undefined) return { usage: message.usage, index: i };
  }
  return undefined;
}

export function estimateLocalMessagesTokens(
  messages: readonly LocalMessage[],
): number {
  return messages.reduce(
    (total, message) => total + estimateLocalMessageTokens(message),
    0,
  );
}

export function estimateLocalContextTokens(
  messages: readonly LocalMessage[],
): LocalContextTokenEstimate {
  const usageInfo = getAssistantUsageInfo(
    messages,
    latestCompactionBoundaryTimestamp(messages),
  );
  if (!usageInfo) {
    const estimated = estimateLocalMessagesTokens(messages);
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  const usageTokens = contextTokensFromLocalUsage(usageInfo.usage) ?? 0;
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message) trailingTokens += estimateLocalMessageTokens(message);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: usageInfo.index,
  };
}
