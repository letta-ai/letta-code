import type WebSocket from "ws";
import { listConnectProviders } from "@/providers/connect-provider-service";
import type {
  ListConnectProvidersCommand,
  ListConnectProvidersResponseMessage,
} from "@/types/protocol_v2";
import { isListConnectProvidersCommand } from "@/websocket/listener/protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

type ConnectProvidersCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

export async function buildListConnectProvidersResponse(
  command: ListConnectProvidersCommand,
): Promise<ListConnectProvidersResponseMessage> {
  const result = await listConnectProviders(command.target);
  return {
    type: "list_connect_providers_response",
    request_id: command.request_id,
    success: true,
    target: result.target,
    providers: result.providers,
  };
}

export function handleConnectProvidersCommand(
  parsed: unknown,
  context: ConnectProvidersCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;

  if (isListConnectProvidersCommand(parsed)) {
    runDetachedListenerTask("list_connect_providers", async () => {
      try {
        const response = await buildListConnectProvidersResponse(parsed);
        safeSocketSend(
          socket,
          response,
          "listener_list_connect_providers_send_failed",
          "listener_list_connect_providers",
        );
      } catch (error) {
        safeSocketSend(
          socket,
          {
            type: "list_connect_providers_response",
            request_id: parsed.request_id,
            success: false,
            target: parsed.target,
            providers: [],
            error:
              error instanceof Error
                ? error.message
                : "Failed to list connect providers",
          },
          "listener_list_connect_providers_send_failed",
          "listener_list_connect_providers",
        );
      }
    });
    return true;
  }

  return false;
}
