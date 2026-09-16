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
  return listEnabledChannelIds({
    restoreAgentScope: options.restoreAgentScope ?? null,
  });
}
