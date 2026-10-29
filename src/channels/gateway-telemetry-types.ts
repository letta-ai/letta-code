import { loadChannelAccounts } from "@/channels/accounts";
import { getSupportedChannelIds } from "@/channels/plugin-registry";
import type { ChannelRestoreAgentScope } from "@/channels/restore-scope";
import { listEnabledChannelIds } from "@/channels/service-snapshots";

export function resolveChannelGatewayTelemetryTypes(options: {
  restoreEnabledChannels: boolean;
  channelNames: readonly string[];
  restoreAgentScope?: ChannelRestoreAgentScope | null;
}): string[] {
  if (!options.restoreEnabledChannels) {
    return [...options.channelNames];
  }
  // Account commands run in the ChannelGateway child, so the listener's
  // process-local account cache goes stale. Re-read from disk before listing.
  for (const channelId of getSupportedChannelIds()) {
    loadChannelAccounts(channelId);
  }
  return listEnabledChannelIds({
    restoreAgentScope: options.restoreAgentScope ?? null,
  });
}
