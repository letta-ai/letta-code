import type {
  ClientToolsetConfig,
  InputCommand,
  InputCreateMessagePayload,
  RuntimeScope,
} from "@/types/protocol_v2";
import { isValidApprovalResponseBody } from "./approval";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeScope(value: unknown): value is RuntimeScope {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.agent_id === "string" &&
    value.agent_id.length > 0 &&
    typeof value.conversation_id === "string" &&
    value.conversation_id.length > 0
  );
}

const TOOLSET_PREFERENCES = new Set([
  "auto",
  "codex",
  "codex_snake",
  "default",
  "gemini",
  "gemini_snake",
  "none",
]);

function isClientToolsetConfig(value: unknown): value is ClientToolsetConfig {
  if (!isObjectRecord(value)) return false;
  return (
    (value.base === undefined ||
      (typeof value.base === "string" &&
        TOOLSET_PREFERENCES.has(value.base))) &&
    (value.include === undefined || isStringArray(value.include))
  );
}

export function isInputCommand(value: unknown): value is InputCommand {
  if (!isObjectRecord(value)) return false;
  if (
    value.type !== "input" ||
    !isRuntimeScope(value.runtime) ||
    (value.request_id !== undefined && typeof value.request_id !== "string") ||
    !isObjectRecord(value.payload)
  ) {
    return false;
  }

  const payload = value.payload;
  if (payload.kind === "create_message") {
    return (
      Array.isArray(payload.messages) &&
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
  if (payload.kind === "approval_response") {
    return isValidApprovalResponseBody(payload);
  }
  return false;
}

export function legacyEnvironmentMessageToInputCommand(
  value: unknown,
): InputCommand | null {
  if (!isObjectRecord(value)) return null;
  if (
    value.type !== "message" ||
    typeof value.agentId !== "string" ||
    value.agentId.length === 0 ||
    !Array.isArray(value.messages)
  ) {
    return null;
  }
  const conversationId =
    typeof value.conversationId === "string"
      ? value.conversationId
      : typeof value.conversation_id === "string"
        ? value.conversation_id
        : "default";
  return {
    type: "input",
    runtime: {
      agent_id: value.agentId,
      conversation_id: conversationId,
    },
    payload: {
      kind: "create_message",
      messages: value.messages as InputCreateMessagePayload["messages"],
      client_tool_allowlist: isStringArray(value.clientToolAllowlist)
        ? value.clientToolAllowlist
        : undefined,
      client_toolset: isClientToolsetConfig(value.clientToolset)
        ? value.clientToolset
        : undefined,
      external_tool_scope_ids: isStringArray(value.externalToolScopeIds)
        ? value.externalToolScopeIds
        : undefined,
    },
  };
}

export function getInvalidInputReason(value: unknown): {
  runtime: RuntimeScope;
  reason: string;
} | null {
  if (
    !isObjectRecord(value) ||
    value.type !== "input" ||
    !isRuntimeScope(value.runtime)
  ) {
    return null;
  }
  if (value.request_id !== undefined && typeof value.request_id !== "string") {
    return {
      runtime: value.runtime,
      reason: "Protocol violation: input.request_id must be a string",
    };
  }
  if (!isObjectRecord(value.payload)) {
    return {
      runtime: value.runtime,
      reason: "Protocol violation: input.payload must be an object",
    };
  }
  const payload = value.payload;
  if (payload.kind === "create_message") {
    if (!Array.isArray(payload.messages)) {
      return {
        runtime: value.runtime,
        reason:
          "Protocol violation: input.kind=create_message requires payload.messages[]",
      };
    }
    if (
      payload.client_tool_allowlist !== undefined &&
      !isStringArray(payload.client_tool_allowlist)
    ) {
      return {
        runtime: value.runtime,
        reason:
          "Protocol violation: input.payload.client_tool_allowlist must be string[]",
      };
    }
    if (
      payload.client_toolset !== undefined &&
      !isClientToolsetConfig(payload.client_toolset)
    ) {
      return {
        runtime: value.runtime,
        reason:
          "Protocol violation: input.payload.client_toolset must contain an optional valid base and string[] include",
      };
    }
    if (
      payload.exclude_interactive_tools !== undefined &&
      typeof payload.exclude_interactive_tools !== "boolean"
    ) {
      return {
        runtime: value.runtime,
        reason:
          "Protocol violation: input.payload.exclude_interactive_tools must be boolean",
      };
    }
    if (
      payload.external_tool_scope_ids !== undefined &&
      !isStringArray(payload.external_tool_scope_ids)
    ) {
      return {
        runtime: value.runtime,
        reason:
          "Protocol violation: input.payload.external_tool_scope_ids must be string[]",
      };
    }
    return null;
  }
  if (payload.kind === "approval_response") {
    if (!isValidApprovalResponseBody(payload)) {
      return {
        runtime: value.runtime,
        reason:
          "Protocol violation: input.kind=approval_response requires payload.request_id and either payload.decision or payload.error",
      };
    }
    return null;
  }
  return {
    runtime: value.runtime,
    reason: `Unsupported input payload kind: ${String(payload.kind)}`,
  };
}
