import type {
  ChannelReasoningEffort,
  ChannelReasoningSelection,
} from "./model-picker-types";
import { getChannelDisplayName } from "./plugin-registry";

const CHANNEL_REASONING_EFFORTS: ChannelReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function channelDisplayName(channelId: string): string {
  try {
    return getChannelDisplayName(channelId);
  } catch {
    return channelId;
  }
}

export type ParsedChannelModelArgs =
  | { kind: "model"; modelIdentifier?: string }
  | { kind: "reasoning"; reasoningEffort: ChannelReasoningSelection }
  | { kind: "invalid-reasoning" };

export function parseChannelModelArgs(args: string): ParsedChannelModelArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens[0]?.toLowerCase() !== "reasoning") {
    return {
      kind: "model",
      ...(args.trim() ? { modelIdentifier: args.trim() } : {}),
    };
  }
  if (tokens.length !== 2) {
    return { kind: "invalid-reasoning" };
  }

  const requested = tokens[1]?.toLowerCase();
  if (requested === "default") {
    return { kind: "reasoning", reasoningEffort: null };
  }
  if (
    requested &&
    CHANNEL_REASONING_EFFORTS.includes(requested as ChannelReasoningEffort)
  ) {
    return {
      kind: "reasoning",
      reasoningEffort: requested as ChannelReasoningEffort,
    };
  }
  return { kind: "invalid-reasoning" };
}

export function channelModelCommandPrefix(
  channelId: string,
): "/model" | "@agent /model" {
  return channelId === "slack" ? "@agent /model" : "/model";
}

export function formatChannelReasoningSelection(
  effort: ChannelReasoningSelection,
): string {
  const labels: Record<ChannelReasoningEffort, string> = {
    none: "No reasoning",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
  return effort === null ? "Default" : labels[effort];
}

export function buildChannelModelReasoningUsageMessage(
  channelId: string,
): string {
  return `Use ${channelModelCommandPrefix(channelId)} reasoning <default|none|minimal|low|medium|high|xhigh|max>.`;
}

export function buildChannelModelReasoningUnsupportedMessage(
  channelId: string,
  params: {
    modelLabel: string;
    requested: ChannelReasoningSelection;
    supported: ChannelReasoningSelection[];
  },
): string {
  const displayName = channelDisplayName(channelId);
  if (params.supported.length === 0) {
    return `${displayName} model ${params.modelLabel} does not report configurable reasoning levels.`;
  }
  const supported = params.supported
    .map((effort) => (effort === null ? "default" : effort))
    .join("|");
  return `${displayName} cannot set ${params.modelLabel} reasoning to ${formatChannelReasoningSelection(params.requested)}. Use ${channelModelCommandPrefix(channelId)} reasoning <${supported}>.`;
}

export function buildChannelModelReasoningUpdatedMessage(
  channelId: string,
  params: {
    modelLabel: string;
    reasoningEffort: ChannelReasoningSelection;
    appliedTo?: "agent" | "conversation";
  },
): string {
  const displayName = channelDisplayName(channelId);
  const scope = params.appliedTo === "agent" ? "agent" : "conversation";
  return `${displayName} updated this ${scope}'s reasoning for ${params.modelLabel} to ${formatChannelReasoningSelection(params.reasoningEffort)}.`;
}

export function buildChannelModelReasoningUpdateFailedMessage(
  channelId: string,
  params: {
    modelLabel: string;
    reasoningEffort: ChannelReasoningSelection;
    error: string;
  },
): string {
  const displayName = channelDisplayName(channelId);
  return `${displayName} could not set ${params.modelLabel} reasoning to ${formatChannelReasoningSelection(params.reasoningEffort)}: ${params.error}`;
}
