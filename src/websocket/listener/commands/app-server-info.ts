import type WebSocket from "ws";
import { isLocalBackendEnabled } from "@/backend";
import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerInfoCommand,
  type AppServerInfoResponseMessage,
} from "@/types/app-server-info";
import { getVersion } from "@/version";

export interface AppServerInfoCommandContext {
  socket: WebSocket;
  safeSocketSend: (
    socket: WebSocket,
    payload: unknown,
    errorType: string,
    context: string,
  ) => boolean;
}

export function buildAppServerInfoResponse(
  command: AppServerInfoCommand,
  options: { backend: "local" | "api"; version: string },
): AppServerInfoResponseMessage {
  return {
    type: "app_server_info_response",
    request_id: command.request_id,
    success: true,
    backend: options.backend,
    letta_code_version: options.version,
    protocol_version: APP_SERVER_PROTOCOL_VERSION,
    capabilities: {
      agent_management: true,
      conversation_management: true,
      memory_management: true,
      runtime_start: true,
      runtime_external_tools_update: true,
      split_channels: false,
    },
  };
}

export function getAppServerInfoResponse(
  requestId: string,
): AppServerInfoResponseMessage {
  return buildAppServerInfoResponse(
    { type: "app_server_info", request_id: requestId },
    {
      backend: isLocalBackendEnabled() ? "local" : "api",
      version: getVersion(),
    },
  );
}

export function handleAppServerInfoCommand(
  command: AppServerInfoCommand,
  context: AppServerInfoCommandContext,
): void {
  context.safeSocketSend(
    context.socket,
    getAppServerInfoResponse(command.request_id),
    "listener_app_server_info_send_failed",
    "listener_app_server_info",
  );
}
