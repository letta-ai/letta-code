import { isClientPreferences } from "@/tools/client-preferences";
import { isToolsetPreference } from "@/tools/toolset-catalog";
import type { ClientToolsetConfig } from "@/types/protocol_v2";
import { isObjectRecord, isStringArray } from "./protocol-validation";

export function isClientToolsetConfig(
  value: unknown,
): value is ClientToolsetConfig {
  if (!isObjectRecord(value)) return false;
  return (
    (value.base === undefined || isToolsetPreference(value.base)) &&
    (value.include === undefined || isStringArray(value.include))
  );
}

/** The accepted-input predicate and its rejection message use the same checks. */
export function getInputToolSelectionError(
  payload: Record<string, unknown>,
): string | null {
  if (
    payload.client_tool_allowlist !== undefined &&
    !isStringArray(payload.client_tool_allowlist)
  )
    return "Protocol violation: input.payload.client_tool_allowlist must be string[]";
  if (
    payload.client_toolset !== undefined &&
    !isClientToolsetConfig(payload.client_toolset)
  )
    return "Protocol violation: input.payload.client_toolset must contain an optional valid base and string[] include";
  if (
    payload.client_preferences !== undefined &&
    !isClientPreferences(payload.client_preferences)
  )
    return "Protocol violation: client_preferences must contain only an optional toolset with include: known bundled tool names[]";
  if (
    payload.exclude_interactive_tools !== undefined &&
    typeof payload.exclude_interactive_tools !== "boolean"
  )
    return "Protocol violation: input.payload.exclude_interactive_tools must be boolean";
  if (
    payload.external_tool_scope_ids !== undefined &&
    !isStringArray(payload.external_tool_scope_ids)
  )
    return "Protocol violation: input.payload.external_tool_scope_ids must be string[]";
  return null;
}
