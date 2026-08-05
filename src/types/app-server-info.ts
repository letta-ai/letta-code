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
  /** Wire value reported by the server; clients compare it with their supported version. */
  protocol_version: number;
  capabilities: {
    agent_management: boolean;
    conversation_management: boolean;
    memory_management: boolean;
    runtime_start: boolean;
    runtime_external_tools_update?: boolean;
    split_channels: boolean;
  };
}

export function isAppServerInfoResponseMessage(
  message: unknown,
): message is AppServerInfoResponseMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }

  const candidate = message as Record<string, unknown>;
  const capabilities = candidate.capabilities;
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    return false;
  }

  const capabilityRecord = capabilities as Record<string, unknown>;
  return (
    candidate.type === "app_server_info_response" &&
    typeof candidate.request_id === "string" &&
    candidate.request_id.length > 0 &&
    candidate.success === true &&
    (candidate.backend === "local" || candidate.backend === "api") &&
    typeof candidate.letta_code_version === "string" &&
    typeof candidate.protocol_version === "number" &&
    Number.isInteger(candidate.protocol_version) &&
    typeof capabilityRecord.agent_management === "boolean" &&
    typeof capabilityRecord.conversation_management === "boolean" &&
    typeof capabilityRecord.memory_management === "boolean" &&
    typeof capabilityRecord.runtime_start === "boolean" &&
    (capabilityRecord.runtime_external_tools_update === undefined ||
      typeof capabilityRecord.runtime_external_tools_update === "boolean") &&
    typeof capabilityRecord.split_channels === "boolean"
  );
}
