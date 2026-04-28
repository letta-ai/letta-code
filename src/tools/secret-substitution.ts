/**
 * Secret substitution for tool arguments.
 * Replaces $SECRET_NAME patterns with actual values from the secrets store.
 */

import { loadSecrets } from "../utils/secretsStore";

/**
 * Pattern to match $SECRET_NAME where SECRET_NAME is uppercase with underscores.
 * Examples: $API_KEY, $MY_SECRET, $DB_PASSWORD_123
 */
const SECRET_PATTERN = /\$([A-Z_][A-Z0-9_]*)/g;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Substitute $SECRET_NAME patterns in a string with actual secret values.
 * If a secret is not found, the pattern is left unchanged.
 */
export function substituteSecretsInString(
  input: string,
  agentId?: string,
): string {
  const secrets = loadSecrets(agentId);
  return input.replace(SECRET_PATTERN, (match, name) => {
    const value = secrets[name];
    return value !== undefined ? value : match;
  });
}

function substituteSecretsInValue(value: unknown, agentId?: string): unknown {
  if (typeof value === "string") {
    return substituteSecretsInString(value, agentId);
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteSecretsInValue(item, agentId));
  }

  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = substituteSecretsInValue(nestedValue, agentId);
    }
    return result;
  }

  return value;
}

/**
 * Substitute secrets in tool arguments.
 * Processes strings recursively in arrays and plain objects; other values are
 * passed through unchanged.
 * Only applies to shell tools (checked by caller in manager.ts).
 */
export function substituteSecretsInArgs(
  args: Record<string, unknown>,
  agentId?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    result[key] = substituteSecretsInValue(value, agentId);
  }

  return result;
}

/**
 * Scrub secret values from a string, replacing them with an explicit
 * placeholder that makes it unambiguous to the LLM that the value is hidden.
 * Used to prevent secret values from leaking into agent context via tool output.
 */
export function scrubSecretsFromString(
  input: string,
  agentId?: string,
): string {
  const secrets = loadSecrets(agentId);
  let result = input;
  // Replace longer values first to avoid partial matches
  const entries = Object.entries(secrets).sort(
    ([, a], [, b]) => b.length - a.length,
  );
  for (const [name, value] of entries) {
    if (value.length > 0) {
      result = result.replaceAll(value, `${name}=<REDACTED>`);
    }
  }
  return result;
}
