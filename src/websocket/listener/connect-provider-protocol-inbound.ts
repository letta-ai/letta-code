import { isChatGPTOAuthConfig } from "@/types/chatgpt-oauth";
import type { ConnectProviderCommand } from "@/types/protocol_v2";
import { isStringRecord } from "./protocol-validation";

export function isConnectProviderCommand(
  value: unknown,
): value is ConnectProviderCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return (
    command.type === "connect_provider" &&
    typeof command.request_id === "string" &&
    command.target === "local" &&
    typeof command.provider_id === "string" &&
    (command.auth_method_id === undefined ||
      typeof command.auth_method_id === "string") &&
    isStringRecord(command.fields) &&
    (command.provider_name === undefined ||
      typeof command.provider_name === "string") &&
    (command.oauth_config === undefined ||
      isChatGPTOAuthConfig(command.oauth_config))
  );
}
