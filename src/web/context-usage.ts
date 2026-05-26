import type { ContextData } from "./types";

export interface ContextUsageSnapshot {
  contextWindow: number;
  usedTokens: number;
  model: string;
}

type BreakdownKey = keyof ContextData["breakdown"];

const BREAKDOWN_KEYS: BreakdownKey[] = [
  "system",
  "coreMemory",
  "externalMemory",
  "summaryMemory",
  "tools",
  "messages",
];

function emptyBreakdown(): ContextData["breakdown"] {
  return {
    system: 0,
    coreMemory: 0,
    externalMemory: 0,
    summaryMemory: 0,
    tools: 0,
    messages: 0,
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function scaleBreakdownToUsedTokens(
  breakdown: ContextData["breakdown"] | undefined,
  usedTokens: number,
): ContextData["breakdown"] {
  if (!breakdown) {
    return { ...emptyBreakdown(), messages: usedTokens };
  }

  const weights = BREAKDOWN_KEYS.map((key) => ({
    key,
    tokens: nonNegativeInteger(breakdown[key]),
  }));
  const total = weights.reduce((sum, item) => sum + item.tokens, 0);
  if (total <= 0) {
    return { ...emptyBreakdown(), messages: usedTokens };
  }

  const scaled = emptyBreakdown();
  const remainders = weights.map((item) => {
    const exact = (item.tokens / total) * usedTokens;
    const floor = Math.floor(exact);
    scaled[item.key] = floor;
    return { key: item.key, remainder: exact - floor };
  });

  let remaining =
    usedTokens - BREAKDOWN_KEYS.reduce((sum, key) => sum + scaled[key], 0);
  remainders.sort((a, b) => b.remainder - a.remainder);
  for (const item of remainders) {
    if (remaining <= 0) break;
    scaled[item.key] += 1;
    remaining--;
  }

  return scaled;
}

export function applyContextUsageSnapshot(
  context: ContextData | undefined,
  snapshot: ContextUsageSnapshot | undefined,
): ContextData | undefined {
  const usedTokens = nonNegativeInteger(snapshot?.usedTokens);
  if (!snapshot || usedTokens <= 0) {
    return context;
  }

  const snapshotContextWindow = nonNegativeInteger(snapshot.contextWindow);
  const contextWindow =
    snapshotContextWindow > 0
      ? snapshotContextWindow
      : nonNegativeInteger(context?.contextWindow);
  const model =
    snapshot.model && snapshot.model !== "unknown"
      ? snapshot.model
      : context?.model || snapshot.model || "unknown";

  return {
    contextWindow,
    usedTokens,
    model,
    breakdown: scaleBreakdownToUsedTokens(context?.breakdown, usedTokens),
  };
}
