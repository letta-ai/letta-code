import type { ExternalToolDefinitionPayload } from "@/types/app-server-protocol";
import { buildMessageChannelExternalToolDefinition } from "./message-channel-tool-definition";
import { resolveLocalMessageChannelToolChannels } from "./message-tool";
import type { ChannelTurnSource } from "./types";

export async function buildGatewayMessageChannelTool(
  sources: ChannelTurnSource[],
): Promise<ExternalToolDefinitionPayload | null> {
  if (sources.length === 0) return null;

  const seen = new Set<string>();
  const channels = sources
    .map((source) => ({
      channelId: source.channel,
      accountId: source.accountId ?? null,
    }))
    .filter(({ channelId, accountId }) => {
      const key = `${channelId}:${accountId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return buildMessageChannelExternalToolDefinition({
    channels: await resolveLocalMessageChannelToolChannels({ channels }),
    scoped: true,
    allowProactiveTargets: true,
  });
}
