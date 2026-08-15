import type {
  InputTeleportContinuePayload,
  TeleportProtocolCommand,
} from "@/types/teleport-protocol";
import { isObjectRecord, isRuntimeScope } from "./protocol-validation";

export function isTeleportContinuePayload(
  value: unknown,
): value is InputTeleportContinuePayload {
  if (!isObjectRecord(value) || !isObjectRecord(value.source)) return false;
  return (
    value.kind === "teleport_continue" &&
    typeof value.teleport_id === "string" &&
    value.teleport_id.length > 0 &&
    typeof value.source.device_id === "string" &&
    typeof value.source.connection_name === "string" &&
    (value.continuation === undefined ||
      (isObjectRecord(value.continuation) &&
        Array.isArray(value.continuation.approvals)))
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
