import type WebSocket from "ws";
import { clearAvailableModelsCache } from "@/agent/available-models";
import {
  connectProvider,
  disconnectProvider,
  listConnectProviders,
} from "@/providers/connect-provider-service";
import type {
  ConnectProviderCommand,
  ConnectProviderResponseMessage,
  DisconnectProviderCommand,
  DisconnectProviderResponseMessage,
  ListConnectProvidersCommand,
  ListConnectProvidersResponseMessage,
} from "@/types/protocol_v2";
import {
  isConnectProviderCommand,
  isDisconnectProviderCommand,
  isListConnectProvidersCommand,
} from "@/websocket/listener/protocol-inbound";
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

export async function buildConnectProviderResponse(
  command: ConnectProviderCommand,
): Promise<ConnectProviderResponseMessage> {
  const result = await connectProvider({
    target: command.target,
    providerId: command.provider_id,
    ...(command.auth_method_id ? { authMethodId: command.auth_method_id } : {}),
    fields: command.fields,
  });
  clearAvailableModelsCache();
  return {
    type: "connect_provider_response",
    request_id: command.request_id,
    success: true,
    target: result.target,
    providers: result.providers,
    models_may_have_changed: true,
  };
}

export async function buildDisconnectProviderResponse(
  command: DisconnectProviderCommand,
): Promise<DisconnectProviderResponseMessage> {
  const result = await disconnectProvider({
    target: command.target,
    providerId: command.provider_id,
    ...(command.provider_name ? { providerName: command.provider_name } : {}),
  });
  clearAvailableModelsCache();
  return {
    type: "disconnect_provider_response",
    request_id: command.request_id,
    success: true,
    target: result.target,
    providers: result.providers,
    models_may_have_changed: true,
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

  if (isConnectProviderCommand(parsed)) {
    runDetachedListenerTask("connect_provider", async () => {
      try {
        const response = await buildConnectProviderResponse(parsed);
        safeSocketSend(
          socket,
          response,
          "listener_connect_provider_send_failed",
          "listener_connect_provider",
        );
      } catch (error) {
        safeSocketSend(
          socket,
          {
            type: "connect_provider_response",
            request_id: parsed.request_id,
            success: false,
            target: parsed.target,
            providers: [],
            models_may_have_changed: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to connect provider",
          },
          "listener_connect_provider_send_failed",
          "listener_connect_provider",
        );
      }
    });
    return true;
  }

  if (isDisconnectProviderCommand(parsed)) {
    runDetachedListenerTask("disconnect_provider", async () => {
      try {
        const response = await buildDisconnectProviderResponse(parsed);
        safeSocketSend(
          socket,
          response,
          "listener_disconnect_provider_send_failed",
          "listener_disconnect_provider",
        );
      } catch (error) {
        safeSocketSend(
          socket,
          {
            type: "disconnect_provider_response",
            request_id: parsed.request_id,
            success: false,
            target: parsed.target,
            providers: [],
            models_may_have_changed: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to disconnect provider",
          },
          "listener_disconnect_provider_send_failed",
          "listener_disconnect_provider",
        );
      }
    });
    return true;
  }

  return false;
}
