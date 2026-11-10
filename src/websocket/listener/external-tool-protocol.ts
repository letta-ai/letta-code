import { isToolsetPreference } from "@/tools/toolset-catalog";
import type {
  ExternalToolCallResponseCommand,
  RuntimeExternalToolsUpdateCommand,
  RuntimeToolPolicy,
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
    isRecord(value.parameters) &&
    (value.auto_background === undefined ||
      typeof value.auto_background === "boolean") &&
    (value.timeout_ms === undefined ||
      (typeof value.timeout_ms === "number" &&
        Number.isSafeInteger(value.timeout_ms) &&
        value.timeout_ms >= 1_000 &&
        value.timeout_ms <= 300_000))
  );
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

// A legacy scope_id is still accepted so older controllers are not rejected;
// registration ignores it.
export function isRuntimeStartExternalToolsGroup(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.tools) &&
    value.tools.every(isExternalToolDefinitionPayload) &&
    (value.capabilities === undefined ||
      (isRecord(value.capabilities) &&
        (value.capabilities.external_tool_call_cancel === undefined ||
          typeof value.capabilities.external_tool_call_cancel === "boolean")))
  );
}

export function isRuntimeToolPolicy(
  value: unknown,
): value is RuntimeToolPolicy {
  if (!isRecord(value)) return false;
  const toolset = value.toolset;
  return (
    (toolset === undefined ||
      (isRecord(toolset) &&
        (toolset.base === undefined || isToolsetPreference(toolset.base)) &&
        (toolset.include === undefined || isStringList(toolset.include)))) &&
    (value.allowlist === undefined || isStringList(value.allowlist)) &&
    (value.exclude_interactive === undefined ||
      typeof value.exclude_interactive === "boolean") &&
    (value.foreground_yield_ms === undefined ||
      (typeof value.foreground_yield_ms === "number" &&
        Number.isFinite(value.foreground_yield_ms) &&
        value.foreground_yield_ms > 0))
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
      !update.external_tools.every(isRuntimeStartExternalToolsGroup) ||
      (update.tool_policy !== undefined &&
        !isRuntimeToolPolicy(update.tool_policy))
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
