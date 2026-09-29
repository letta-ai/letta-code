import { isValidApprovalResponseBody } from "./approval";
import {
  isClientToolsetConfig,
  isRequestScopedClientSkills,
  isRequestScopedSecretEnv,
  isRuntimeScope,
  isStringArray,
} from "./protocol-validation";
import { isTeleportContinuePayload } from "./teleport-protocol-inbound";
import type { InvalidInputCommand } from "./types";

export function getInvalidInputCommand(
  value: unknown,
): InvalidInputCommand | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    type?: unknown;
    runtime?: unknown;
    payload?: unknown;
  };
  if (candidate.type !== "input" || !isRuntimeScope(candidate.runtime)) {
    return null;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return {
      type: "__invalid_input",
      runtime: candidate.runtime,
      reason: "Protocol violation: input.payload must be an object",
    };
  }
  const payload = candidate.payload as Record<string, unknown>;
  const violation = getCreateMessageViolation(payload);
  if (payload.kind === "create_message") {
    return violation
      ? {
          type: "__invalid_input",
          runtime: candidate.runtime,
          reason: violation,
        }
      : null;
  }
  if (payload.kind === "approval_response") {
    return isValidApprovalResponseBody(payload)
      ? null
      : {
          type: "__invalid_input",
          runtime: candidate.runtime,
          reason:
            "Protocol violation: input.kind=approval_response requires payload.request_id and either payload.decision or payload.error",
        };
  }
  if (payload.kind === "teleport_continue") {
    return isTeleportContinuePayload(payload)
      ? null
      : {
          type: "__invalid_input",
          runtime: candidate.runtime,
          reason:
            "Protocol violation: input.kind=teleport_continue requires teleport_id, source, and optional continuation.approvals[]",
        };
  }
  return {
    type: "__invalid_input",
    runtime: candidate.runtime,
    reason: `Unsupported input payload kind: ${String(payload.kind)}`,
  };
}

export function getCreateMessageViolation(
  payload: Record<string, unknown>,
): string | null {
  if (payload.kind !== "create_message") return null;
  if (!Array.isArray(payload.messages)) {
    return "Protocol violation: input.kind=create_message requires payload.messages[]";
  }
  if (
    payload.image_failure_mode !== undefined &&
    payload.image_failure_mode !== "strict" &&
    payload.image_failure_mode !== "drop"
  ) {
    return "Protocol violation: input.payload.image_failure_mode must be strict or drop";
  }
  if (
    payload.client_skills !== undefined &&
    !isRequestScopedClientSkills(payload.client_skills)
  ) {
    return "Protocol violation: input.payload.client_skills must be an array of at most 32 {name, description, location} string entries";
  }
  if (
    payload.secret_env !== undefined &&
    !isRequestScopedSecretEnv(payload.secret_env)
  ) {
    return "Protocol violation: input.payload.secret_env must contain bounded uppercase string entries";
  }
  if (
    payload.client_tool_allowlist !== undefined &&
    !isStringArray(payload.client_tool_allowlist)
  ) {
    return "Protocol violation: input.payload.client_tool_allowlist must be string[]";
  }
  if (
    payload.client_toolset !== undefined &&
    !isClientToolsetConfig(payload.client_toolset)
  ) {
    return "Protocol violation: input.payload.client_toolset must contain an optional valid base and string[] include";
  }
  if (
    payload.exclude_interactive_tools !== undefined &&
    typeof payload.exclude_interactive_tools !== "boolean"
  ) {
    return "Protocol violation: input.payload.exclude_interactive_tools must be boolean";
  }
  if (
    payload.external_tool_scope_ids !== undefined &&
    !isStringArray(payload.external_tool_scope_ids)
  ) {
    return "Protocol violation: input.payload.external_tool_scope_ids must be string[]";
  }
  return null;
}
