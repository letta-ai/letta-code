import { isToolsetPreference } from "@/tools/toolset-catalog";
import type { NotificationSponsorshipReference } from "@/types/notification-sponsorship";
import { isObjectRecord, isStringArray } from "./protocol-validation";

function isNotificationSponsorshipReference(
  value: unknown,
): value is NotificationSponsorshipReference {
  return (
    isObjectRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.delivery_id === "string" &&
    value.delivery_id.length > 0 &&
    typeof value.client_message_id === "string" &&
    value.client_message_id.length > 0
  );
}

function isClientToolsetConfig(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    (value.base === undefined || isToolsetPreference(value.base)) &&
    (value.include === undefined || isStringArray(value.include))
  );
}

export function isValidNotificationMessagePayload(
  payload: Record<string, unknown>,
): boolean {
  const payloadFields = new Set([
    "kind",
    "messages",
    "client_message_id",
    "notification_sponsorship",
    "image_failure_mode",
    "client_tool_allowlist",
    "client_toolset",
    "external_tool_scope_ids",
    "exclude_interactive_tools",
    "response_format",
  ]);
  const messageFields = new Set([
    "role",
    "content",
    "client_message_id",
    "otid",
    "attribution",
  ]);
  if (
    Object.keys(payload).some((field) => !payloadFields.has(field)) ||
    !Array.isArray(payload.messages) ||
    payload.messages.length !== 1 ||
    typeof payload.client_message_id !== "string" ||
    payload.client_message_id.length === 0 ||
    !isNotificationSponsorshipReference(payload.notification_sponsorship) ||
    payload.notification_sponsorship.client_message_id !==
      payload.client_message_id ||
    !isObjectRecord(payload.messages[0]) ||
    Object.keys(payload.messages[0]).some(
      (field) => !messageFields.has(field),
    ) ||
    payload.messages[0].role !== "user" ||
    !("content" in payload.messages[0]) ||
    payload.messages[0].client_message_id !== payload.client_message_id ||
    ("otid" in payload.messages[0] &&
      payload.messages[0].otid !== payload.client_message_id)
  ) {
    return false;
  }
  return (
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
