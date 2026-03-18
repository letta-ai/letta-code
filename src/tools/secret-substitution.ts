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

/**
 * Substitute $SECRET_NAME patterns in a string with actual secret values.
 * If a secret is not found, the pattern is left unchanged.
 */
export function substituteSecretsInString(input: string): string {
  const secrets = loadSecrets();
  return input.replace(SECRET_PATTERN, (match, name) => {
    const value = secrets[name];
    return value !== undefined ? value : match;
  });
}

/**
 * Substitute secrets in tool arguments.
 * Only processes string values; other types are passed through unchanged.
 * Only applies to shell tools (checked by caller in manager.ts).
 */
export function substituteSecretsInArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      result[key] = substituteSecretsInString(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}
