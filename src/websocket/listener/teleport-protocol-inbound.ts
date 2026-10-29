import { isClientPreferences } from "@/tools/client-preferences";
import type {
  InputTeleportContinuePayload,
  TeleportProtocolCommand,
} from "@/types/teleport-protocol";
import { isObjectRecord, isRuntimeScope } from "./protocol-validation";

function isOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalStringArrayOrNull(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function isToolReturnContentPart(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  if (
    (value.type === undefined || value.type === "text") &&
    typeof value.text === "string" &&
    isOptionalStringOrNull(value.signature)
  ) {
    return true;
  }
  if (value.type !== undefined && value.type !== "image") {
    return false;
  }
  const source = value.source;
  if (!isObjectRecord(source)) return false;
  if (
    (source.type === undefined || source.type === "url") &&
    typeof source.url === "string"
  ) {
    return true;
  }
  if (
    (source.type === undefined || source.type === "base64") &&
    typeof source.data === "string" &&
    typeof source.media_type === "string" &&
    isOptionalStringOrNull(source.detail)
  ) {
    return true;
  }
  return (
    (source.type === undefined || source.type === "letta") &&
    typeof source.file_id === "string" &&
    isOptionalStringOrNull(source.data) &&
    isOptionalStringOrNull(source.media_type) &&
    isOptionalStringOrNull(source.detail)
  );
}

function isToolReturnContent(value: unknown): boolean {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every(isToolReturnContentPart))
  );
}

export function isTeleportContinuation(value: unknown): boolean {
  if (!isObjectRecord(value) || !Array.isArray(value.approvals)) return false;
  return value.approvals.every((approval) => {
    if (
      !isObjectRecord(approval) ||
      typeof approval.tool_call_id !== "string" ||
      approval.tool_call_id.length === 0
    ) {
      return false;
    }
    if (typeof approval.approve === "boolean") {
      return (
        (approval.type === undefined || approval.type === "approval") &&
        isOptionalStringOrNull(approval.reason) &&
        approval.status === undefined &&
        approval.tool_return === undefined &&
        approval.stdout === undefined &&
        approval.stderr === undefined
      );
    }
    return (
      approval.approve === undefined &&
      (approval.type === undefined || approval.type === "tool") &&
      (approval.status === "success" || approval.status === "error") &&
      isToolReturnContent(approval.tool_return) &&
      (approval.reason === undefined || typeof approval.reason === "string") &&
      isOptionalStringArrayOrNull(approval.stdout) &&
      isOptionalStringArrayOrNull(approval.stderr)
    );
  });
}

export function isTeleportContinuePayload(
  value: unknown,
): value is InputTeleportContinuePayload {
  if (!isObjectRecord(value) || !isObjectRecord(value.source)) return false;
  return (
    value.kind === "teleport_continue" &&
    (value.client_preferences === undefined ||
      isClientPreferences(value.client_preferences)) &&
    typeof value.teleport_id === "string" &&
    value.teleport_id.length > 0 &&
    typeof value.source.device_id === "string" &&
    typeof value.source.connection_name === "string" &&
    (value.continuation === undefined ||
      isTeleportContinuation(value.continuation))
  );
}

export function parseTeleportCommand(
  value: unknown,
): TeleportProtocolCommand | null {
  if (!isObjectRecord(value) || !isRuntimeScope(value.runtime)) return null;
  if (value.type === "teleport_probe" && typeof value.request_id === "string") {
    return value as unknown as TeleportProtocolCommand;
  }
  if (
    value.type === "teleport_request" &&
    typeof value.request_id === "string" &&
    typeof value.teleport_id === "string" &&
    isObjectRecord(value.target) &&
    typeof value.target.connection_id === "string" &&
    typeof value.target.device_id === "string" &&
    typeof value.target.connection_name === "string"
  ) {
    return value as unknown as TeleportProtocolCommand;
  }
  if (
    value.type === "teleport_failed" &&
    typeof value.teleport_id === "string" &&
    typeof value.error === "string"
  ) {
    return value as unknown as TeleportProtocolCommand;
  }
  return null;
}
