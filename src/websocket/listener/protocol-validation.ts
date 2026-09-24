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

export function hasValidActingUserScope(value: {
  acting_user_id?: unknown;
  acting_user_assertion?: unknown;
}): boolean {
  return (
    (value.acting_user_id === undefined ||
      typeof value.acting_user_id === "string") &&
    (value.acting_user_assertion === undefined ||
      typeof value.acting_user_assertion === "string")
  );
}

export function isRuntimeScope(value: unknown): value is RuntimeScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    agent_id?: unknown;
    conversation_id?: unknown;
    acting_user_id?: unknown;
    acting_user_assertion?: unknown;
  };
  return (
    (candidate.agent_id === null ||
      (typeof candidate.agent_id === "string" &&
        candidate.agent_id.length > 0)) &&
    typeof candidate.conversation_id === "string" &&
    candidate.conversation_id.length > 0 &&
    hasValidActingUserScope(candidate)
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
