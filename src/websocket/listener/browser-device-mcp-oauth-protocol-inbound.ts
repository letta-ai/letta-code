import type {
  BrowserDeviceMcpOAuthCancelCommand,
  BrowserDeviceMcpOAuthCommand,
} from "@/types/task-control-protocol";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDOFF_KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const SERVICE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SERVER_URL_LENGTH = 2_048;

export function isBrowserDeviceMcpOAuthProtocolCommand(
  value: unknown,
): value is BrowserDeviceMcpOAuthCommand | BrowserDeviceMcpOAuthCancelCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "browser_device_mcp_oauth") {
    return (
      Object.keys(record).length === 5 &&
      typeof record.request_id === "string" &&
      REQUEST_ID_PATTERN.test(record.request_id) &&
      typeof record.handoff_key === "string" &&
      HANDOFF_KEY_PATTERN.test(record.handoff_key) &&
      typeof record.service === "string" &&
      SERVICE_PATTERN.test(record.service) &&
      typeof record.server_url === "string" &&
      record.server_url.length > 0 &&
      record.server_url.length <= MAX_SERVER_URL_LENGTH &&
      !hasControlCharacters(record.server_url)
    );
  }
  return (
    record.type === "browser_device_mcp_oauth_cancel" &&
    Object.keys(record).length === 2 &&
    typeof record.operation_id === "string" &&
    REQUEST_ID_PATTERN.test(record.operation_id)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
