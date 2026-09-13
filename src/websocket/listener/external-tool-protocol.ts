import type {
  ExternalToolCallResponseCommand,
  RuntimeExternalToolsUpdateCommand,
} from "@/types/protocol_v2";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRuntimeScope(value: unknown): value is {
  agent_id: string;
  conversation_id: string;
} {
  if (!isRecord(value)) return false;
  return (
    typeof value.agent_id === "string" &&
    value.agent_id.length > 0 &&
    typeof value.conversation_id === "string" &&
    value.conversation_id.length > 0
  );
}

function isExternalToolDefinitionPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    (value.label === undefined || typeof value.label === "string") &&
    typeof value.description === "string" &&
    isRecord(value.parameters)
  );
}

export function isRuntimeStartExternalToolsGroup(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.scope_id === undefined || typeof value.scope_id === "string") &&
    Array.isArray(value.tools) &&
    value.tools.every(isExternalToolDefinitionPayload)
  );
}

export function isRuntimeExternalToolsUpdateCommand(
  value: unknown,
): value is RuntimeExternalToolsUpdateCommand {
  if (!isRecord(value)) return false;
  if (
    value.type !== "runtime_external_tools_update" ||
    typeof value.request_id !== "string" ||
    !Array.isArray(value.updates)
  ) {
    return false;
  }
  const runtimeKeys = new Set<string>();
  for (const update of value.updates) {
    if (
      !isRecord(update) ||
      !Array.isArray(update.runtimes) ||
      update.runtimes.length === 0 ||
      !update.runtimes.every(isRuntimeScope) ||
      !Array.isArray(update.external_tools) ||
      !update.external_tools.every(isRuntimeStartExternalToolsGroup)
    ) {
      return false;
    }
    for (const runtime of update.runtimes) {
      const key = `${runtime.agent_id}:${runtime.conversation_id}`;
      if (runtimeKeys.has(key)) return false;
      runtimeKeys.add(key);
    }
  }
  return true;
}

export function isExternalToolCallResponseCommand(
  value: unknown,
): value is ExternalToolCallResponseCommand {
  if (!isRecord(value)) return false;
  if (
    value.type !== "external_tool_call_response" ||
    typeof value.request_id !== "string"
  ) {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    return false;
  }
  if (value.result === undefined) {
    return typeof value.error === "string";
  }
  if (!isRecord(value.result)) return false;
  return (
    Array.isArray(value.result.content) &&
    value.result.content.every(isRecord) &&
    (value.result.is_error === undefined ||
      typeof value.result.is_error === "boolean")
  );
}
