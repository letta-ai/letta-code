import { isToolsetPreference } from "@/tools/toolset-catalog";
import type {
  ClientToolsetConfig,
  RequestScopedClientSkill,
} from "@/types/protocol_v2";
import type { RuntimeScope } from "@/types/runtime-scope";

const MAX_REQUEST_SCOPED_CLIENT_SKILLS = 32;
const MAX_CLIENT_SKILL_NAME_LENGTH = 256;
const MAX_CLIENT_SKILL_DESCRIPTION_LENGTH = 16_384;
const MAX_CLIENT_SKILL_LOCATION_LENGTH = 4_096;
const MAX_REQUEST_SCOPED_SECRET_ENV_ENTRIES = 16;
const MAX_REQUEST_SCOPED_SECRET_VALUE_LENGTH = 16_384;
const REQUEST_SCOPED_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function isBoundedNonEmptyString(value: unknown, maxLength: number): boolean {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

export function isRequestScopedClientSkills(
  value: unknown,
): value is RequestScopedClientSkill[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_REQUEST_SCOPED_CLIENT_SKILLS
  ) {
    return false;
  }

  return value.every((item) => {
    if (!isObjectRecord(item)) return false;
    const keys = Object.keys(item);
    return (
      keys.length === 3 &&
      keys.every(
        (key) => key === "name" || key === "description" || key === "location",
      ) &&
      isBoundedNonEmptyString(item.name, MAX_CLIENT_SKILL_NAME_LENGTH) &&
      isBoundedNonEmptyString(
        item.description,
        MAX_CLIENT_SKILL_DESCRIPTION_LENGTH,
      ) &&
      isBoundedNonEmptyString(item.location, MAX_CLIENT_SKILL_LOCATION_LENGTH)
    );
  });
}

export function isRequestScopedSecretEnv(
  value: unknown,
): value is Record<string, string> {
  if (!isObjectRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_REQUEST_SCOPED_SECRET_ENV_ENTRIES &&
    entries.every(
      ([name, secret]) =>
        REQUEST_SCOPED_SECRET_NAME_PATTERN.test(name) &&
        typeof secret === "string" &&
        secret.length > 0 &&
        secret.length <= MAX_REQUEST_SCOPED_SECRET_VALUE_LENGTH,
    )
  );
}

export function isClientToolsetConfig(
  value: unknown,
): value is ClientToolsetConfig {
  if (!isObjectRecord(value)) return false;
  return (
    (value.base === undefined || isToolsetPreference(value.base)) &&
    (value.include === undefined || isStringArray(value.include))
  );
}

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
