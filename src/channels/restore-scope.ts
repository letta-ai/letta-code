import { isLocalAgentId } from "@/agent/agent-id";
import type { ChannelAccount } from "./types";

export type ChannelRestoreAgentScope = "all" | "cloud" | "local";

export const RESTORE_CHANNEL_AGENT_SCOPE_ENV =
  "LETTA_RESTORE_CHANNEL_AGENT_SCOPE";
export const RESTORE_ENABLED_CHANNELS_AGENT_SCOPE_ENV =
  "LETTA_RESTORE_ENABLED_CHANNELS_AGENT_SCOPE";

type AccountAgentBinding = {
  agentId?: string | null;
  binding?: {
    agentId?: string | null;
  };
};

function normalizeAgentId(agentId: string | null | undefined): string | null {
  const normalized = agentId?.trim();
  return normalized ? normalized : null;
}

export function getChannelAccountAgentId(
  account: ChannelAccount,
): string | null {
  const binding = account as AccountAgentBinding;
  return (
    normalizeAgentId(binding.agentId) ??
    normalizeAgentId(binding.binding?.agentId)
  );
}

export function parseChannelRestoreAgentScope(
  value: string | undefined,
): ChannelRestoreAgentScope | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "all" ||
    normalized === "cloud" ||
    normalized === "local"
  ) {
    return normalized;
  }
  return null;
}

export function shouldRestoreChannelAccountForAgentScope(
  account: ChannelAccount,
  scope: ChannelRestoreAgentScope | null | undefined,
): boolean {
  if (!scope || scope === "all") {
    return true;
  }

  const agentId = getChannelAccountAgentId(account);

  if (scope === "local") {
    return Boolean(agentId && isLocalAgentId(agentId));
  }

  return !agentId || !isLocalAgentId(agentId);
}
