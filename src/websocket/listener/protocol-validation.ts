import type { RuntimeScope } from "@/types/runtime-scope";

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isRuntimeScope(value: unknown): value is RuntimeScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { agent_id?: unknown; conversation_id?: unknown };
  return (
    (candidate.agent_id === null ||
      (typeof candidate.agent_id === "string" &&
        candidate.agent_id.length > 0)) &&
    typeof candidate.conversation_id === "string" &&
    candidate.conversation_id.length > 0
  );
}

export function isAgentRuntimeScope(
  value: unknown,
): value is RuntimeScope<string> {
  return (
    isRuntimeScope(value) &&
    typeof value.agent_id === "string" &&
    value.agent_id.length > 0
  );
}
