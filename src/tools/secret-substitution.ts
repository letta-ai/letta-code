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
 * Scan a command string for `$SECRET_NAME` references and build an env map
 * of matching secrets from the store. The shell will expand these vars
 * natively, so secret values never get injected into the command string.
 */
export function extractSecretEnvFromCommand(
  command: string,
): Record<string, string> {
  const secrets = loadSecrets();
  const env: Record<string, string> = {};
  for (const match of command.matchAll(SECRET_PATTERN)) {
    const name = match[1];
    if (name !== undefined && secrets[name] !== undefined) {
      env[name] = secrets[name];
    }
  }
  return env;
}

/**
 * Scrub secret values from a string, replacing them with an explicit
 * placeholder that makes it unambiguous to the LLM that the value is hidden.
 * Used to prevent secret values from leaking into agent context via tool output.
 */
export function scrubSecretsFromString(input: string): string {
  const secrets = loadSecrets();
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
