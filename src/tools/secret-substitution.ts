/**
 * Secret handling for shell tool arguments and output.
 */

import { loadSecrets } from "@/utils/secrets-store";

/**
 * Pattern to match $SECRET_NAME references where SECRET_NAME is uppercase with
 * underscores, including braced shell forms.
 * Examples: $API_KEY, ${API_KEY}, ${API_KEY:-}, ${#API_KEY}, ${!API_KEY}
 *
 * Braced forms matter: `${NAME}` and the set -u safe `"${NAME:-}"` are
 * standard shell, and an agent that writes them would otherwise get an empty
 * value and conclude the secret is unset even though it exists.
 */
const SECRET_PATTERN = /\$(?:\{[#!]?)?([A-Z_][A-Z0-9_]*)/g;
const SECRET_LIKE_NAME_PATTERN =
  /(?:^|_)(?:API_KEY|APP_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)$/;

export interface ShellSecretResolution {
  env: Record<string, string>;
  missing: string[];
}

function scanSecretReferences(
  command: string | readonly string[],
): Set<string> {
  const references = new Set<string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(SECRET_PATTERN)) {
      const name = match[1];
      if (name !== undefined) {
        references.add(name);
      }
    }
  };

  if (typeof command === "string") {
    scan(command);
  } else {
    for (const part of command) {
      if (typeof part === "string") {
        scan(part);
      }
    }
  }

  return references;
}

/**
 * Resolve agent secrets referenced by a shell command and identify references
 * that look like credentials but are unavailable to the process. Ordinary
 * shell variables remain untouched so commands can keep using local state.
 */
export function resolveShellSecretReferences(
  command: string | readonly string[],
  agentId?: string,
): ShellSecretResolution {
  const secrets = loadSecrets(agentId);
  const env: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of scanSecretReferences(command)) {
    const value = secrets[name];
    if (value !== undefined) {
      env[name] = value;
      continue;
    }
    if (
      process.env[name] === undefined &&
      SECRET_LIKE_NAME_PATTERN.test(name)
    ) {
      missing.push(name);
    }
  }

  return { env, missing: missing.sort() };
}

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
  return resolveShellSecretReferences(command, agentId).env;
}

export function formatMissingSecretsToolReturn(names: string[]): string {
  return JSON.stringify({
    type: "missing_secrets",
    names,
    message: `Add ${names.join(", ")} to this agent's secrets, then retry the command.`,
  });
}

export function prepareShellSecretExecution(
  command: unknown,
  agentId?: string,
): {
  env: Record<string, string>;
  error: { toolReturn: string; status: "error" } | null;
} {
  const isCommand =
    typeof command === "string" ||
    (Array.isArray(command) &&
      command.every((part) => typeof part === "string"));
  const resolution = isCommand
    ? resolveShellSecretReferences(command, agentId)
    : { env: {}, missing: [] };

  return {
    env: resolution.env,
    error:
      resolution.missing.length > 0
        ? {
            toolReturn: formatMissingSecretsToolReturn(resolution.missing),
            status: "error",
          }
        : null,
  };
}

/**
 * Scrub the supplied secret values from a string, replacing them with an
 * explicit placeholder that makes it unambiguous to the LLM that the value is
 * hidden. Callers pass only the secrets available to the current tool invocation.
 */
export function scrubSecretsFromString(
  input: string,
  secrets: Readonly<Record<string, string>>,
): string {
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
