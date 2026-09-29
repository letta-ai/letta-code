import { isToolsetPreference } from "@/tools/toolset-catalog";
import type { ClientToolsetConfig, InputCommand } from "@/types/protocol_v2";
import { isValidApprovalResponseBody } from "./approval";
import { isValidNotificationMessagePayload } from "./notification-sponsorship-protocol";
import {
  isAgentRuntimeScope,
  isObjectRecord,
  isRuntimeScope,
  isStringArray,
} from "./protocol-validation";
import { isTeleportContinuePayload } from "./teleport-protocol-inbound";

function isClientToolsetConfig(value: unknown): value is ClientToolsetConfig {
  return (
    isObjectRecord(value) &&
    (value.base === undefined || isToolsetPreference(value.base)) &&
    (value.include === undefined || isStringArray(value.include))
  );
}

export function isInputCommand(value: unknown): value is InputCommand {
  if (!isObjectRecord(value) || value.type !== "input") return false;
  if (!isRuntimeScope(value.runtime)) return false;
  if (
    value.request_id !== undefined &&
    (typeof value.request_id !== "string" || value.request_id.length === 0)
  ) {
    return false;
  }
  if (!isObjectRecord(value.payload)) return false;
  const payload = value.payload;
  if (payload.kind === "create_message") {
    return (
      Array.isArray(payload.messages) &&
      payload.client_message_id === undefined &&
      payload.notification_sponsorship === undefined &&
      (payload.image_failure_mode === undefined ||
        payload.image_failure_mode === "strict" ||
        payload.image_failure_mode === "drop") &&
      (payload.client_tool_allowlist === undefined ||
        isStringArray(payload.client_tool_allowlist)) &&
      (payload.client_toolset === undefined ||
        isClientToolsetConfig(payload.client_toolset)) &&
      (payload.external_tool_scope_ids === undefined ||
        isStringArray(payload.external_tool_scope_ids)) &&
      (payload.exclude_interactive_tools === undefined ||
        typeof payload.exclude_interactive_tools === "boolean")
    );
  }
  if (payload.kind === "create_notification_message") {
    return isValidNotificationMessagePayload(payload);
  }
  if (payload.kind === "approval_response") {
    return isValidApprovalResponseBody(payload);
  }
  return (
    payload.kind === "teleport_continue" &&
    isAgentRuntimeScope(value.runtime) &&
    isTeleportContinuePayload(payload)
  );
}
