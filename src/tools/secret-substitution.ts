/**
 * Secret handling for shell tool arguments and output.
 */

import { loadSecrets } from "../utils/secretsStore";

/**
 * Pattern to match $SECRET_NAME where SECRET_NAME is uppercase with underscores.
 * Examples: $API_KEY, $MY_SECRET, $DB_PASSWORD_123
 */
const SECRET_PATTERN = /\$([A-Z_][A-Z0-9_]*)/g;

/**
 * Scan a command string or command-argument array for `$SECRET_NAME`
 * references and build an env map of matching secrets from the store.
 * The shell will expand these vars natively, so secret values never get
 * injected into the command string itself.
 */
export function extractSecretEnvFromCommand(
  command: string | readonly string[],
  agentId?: string,
): Record<string, string> {
  const secrets = loadSecrets(agentId);
  const env: Record<string, string> = {};

  const scan = (text: string) => {
    for (const match of text.matchAll(SECRET_PATTERN)) {
      const name = match[1];
      if (name !== undefined && secrets[name] !== undefined) {
        env[name] = secrets[name];
      }
    }
  };

  if (typeof command === "string") {
    scan(command);
    return env;
  }

  for (const part of command) {
    if (typeof part === "string") {
      scan(part);
    }
  }

  return env;
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
