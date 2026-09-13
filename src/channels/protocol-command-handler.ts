import type WebSocket from "ws";
import { handleAccountConfigLifecycleCommand } from "@/channels/protocol-account-commands";
import type {
  ChannelServiceSafeSocketSend,
  ChannelServiceTaskRunner,
  ChannelsCommand,
  ChannelsServiceModule,
} from "@/channels/protocol-command-helpers";
import { loadChannelsService } from "@/channels/protocol-command-helpers";
import { handleRoutingPairingTargetCommand } from "@/channels/protocol-routing-commands";
import { isChannelServiceCommandType } from "@/types/service-protocol";

export type { ChannelsCommand } from "@/channels/protocol-command-helpers";
// Re-export the public API that consumers depend on.
export { setChannelsServiceLoaderOverride } from "@/channels/protocol-command-helpers";

export function isDetachedChannelsCommand(
  parsed: unknown,
): parsed is ChannelsCommand {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    "type" in parsed &&
    isChannelServiceCommandType(parsed.type)
  );
}

export async function handleChannelsProtocolCommand(
  parsed: ChannelsCommand,
  socket: WebSocket,
  runDetachedListenerTask: ChannelServiceTaskRunner,
  safeSocketSend: ChannelServiceSafeSocketSend,
): Promise<boolean> {
  const service: ChannelsServiceModule = await loadChannelsService();

  const handled = await handleAccountConfigLifecycleCommand(
    parsed,
    socket,
    runDetachedListenerTask,
    safeSocketSend,
    service,
  );
  if (handled) {
    return true;
  }

  handleRoutingPairingTargetCommand(parsed, socket, safeSocketSend, service);
  return true;
}
