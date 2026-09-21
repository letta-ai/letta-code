import { getSupportedChannelIds } from "./plugin-registry";
import { readRoutes } from "./routing";

/** Only device-owned routes live here; Cloud-managed channels do not. */
export function getLocalChannelTeleportError(scope: {
  agentId: string;
  conversationId: string;
}): string | null {
  const channels = getSupportedChannelIds().filter((channelId) => {
    return readRoutes(channelId).some(
      (route) =>
        route.agentId === scope.agentId &&
        route.conversationId === scope.conversationId &&
        route.enabled !== false &&
        route.outboundEnabled !== false,
    );
  });
  if (channels.length === 0) return null;
  return `This conversation is bound to ${channels.join(", ")} on this computer. Teleport is blocked because MessageChannel cannot follow the conversation to another computer yet. Remove the channel route or continue locally.`;
}
