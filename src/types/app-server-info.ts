export const APP_SERVER_PROTOCOL_VERSION = 1;

export interface AppServerInfoCommand {
  type: "app_server_info";
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface AppServerInfoResponseMessage {
  type: "app_server_info_response";
  request_id: string;
  /** Synchronous post-auth capability discovery has no domain failure variant. */
  success: true;
  backend: "local" | "api";
  letta_code_version: string;
  protocol_version: typeof APP_SERVER_PROTOCOL_VERSION;
  capabilities: {
    agent_management: boolean;
    conversation_management: boolean;
    memory_management: boolean;
    runtime_start: boolean;
    split_channels: boolean;
  };
}
