/**
 * Secret handling for shell tool arguments and output.
 */

import { INHERITED_SECRET_NAMES_ENV } from "@/agent/subagents/subagent-launcher";
import type { ToolExecutionResult } from "@/tools/manager";
import { loadSecrets } from "@/utils/secrets-store";

const PROTECTED_MANAGED_CLOUD_ENV_NAMES = new Set([
  "AGENT_ID",
  "CONVERSATION_ID",
  "HOME",
  "LETTA_AGENT_ID",
  "LETTA_API_KEY",
  "LETTA_BASE_URL",
  "LETTA_CONVERSATION_ID",
  "LETTA_INHERITED_SECRET_NAMES",
  "LETTA_LISTENER_INSTANCE_ID",
  "LETTA_MANAGED_CLOUD_SANDBOX",
  "LETTA_MEMFS_BASE_URL",
  "LETTA_MEMORY_DIR",
  "LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID",
  "LETTA_SKILLS_DIRECTORY",
  "MEMORY_DIR",
  "PATH",
]);

/**
 * Managed cloud sandboxes are provisioned with an explicit runtime marker.
 * API mode alone is not sufficient: local machines can also use the Cloud API.
 */
export function isManagedCloudSandbox(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.LETTA_MANAGED_CLOUD_SANDBOX === "1";
}

/**
 * Return the current agent's secrets for child-process environment inheritance
 * in managed cloud sandboxes. This stays scoped to the invocation/launch env;
 * process.env is never mutated because one listener can host multiple agents.
 */
function getInheritedSecretEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const serializedNames = env[INHERITED_SECRET_NAMES_ENV];
  if (!serializedNames) return {};

  try {
    const names: unknown = JSON.parse(serializedNames);
    if (!Array.isArray(names)) return {};
    return Object.fromEntries(
      names.flatMap((name) => {
        if (typeof name !== "string") return [];
        const value = env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    );
  } catch {
    return {};
  }
}

export function getScopedSecretRedactions(
  agentId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const inherited = getInheritedSecretEnv(env);
  const current = agentId ? loadSecrets(agentId) : {};
  const redactions = { ...inherited, ...current };
  for (const [name, value] of Object.entries(inherited)) {
    if (current[name] !== undefined && current[name] !== value) {
      let alias = `${name}_INHERITED`;
      while (alias in redactions) alias += "_INHERITED";
      redactions[alias] = value;
    }
  }
  return redactions;
}

export function getManagedCloudAgentSecretEnv(
  agentId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!isManagedCloudSandbox(env)) return {};

  const inherited = getInheritedSecretEnv(env);
  const current = agentId ? loadSecrets(agentId) : {};
  return Object.fromEntries(
    Object.entries({ ...inherited, ...current })
      .map(([name, value]) => [name, inherited[name] ?? value] as const)
      .filter(
        ([name, value]) =>
          !PROTECTED_MANAGED_CLOUD_ENV_NAMES.has(name) &&
          (env[name] === undefined || env[name] === value),
      ),
  );
}

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
  } else {
    for (const part of command) {
      if (typeof part === "string") scan(part);
    }
  }

  return isManagedCloudSandbox()
    ? { ...getManagedCloudAgentSecretEnv(agentId), ...env }
    : env;
}

/**
 * Scrub the supplied secret values from a string, replacing them with an
 * explicit placeholder that makes it unambiguous to the LLM that the value is
 * hidden. Callers pass only the secrets available to the current tool invocation.
 */
export function scrubToolExecutionResult(
  result: ToolExecutionResult,
  secrets: Readonly<Record<string, string>>,
): ToolExecutionResult {
  const scrub = (text: string) => scrubSecretsFromString(text, secrets);
  return {
    ...result,
    toolReturn:
      typeof result.toolReturn === "string"
        ? scrub(result.toolReturn)
        : result.toolReturn.map((block) =>
            block.type === "text"
              ? { ...block, text: scrub(block.text) }
              : block,
          ),
    ...(result.stdout && { stdout: result.stdout.map(scrub) }),
    ...(result.stderr && { stderr: result.stderr.map(scrub) }),
  };
}

export function scrubSecretsFromString(
  input: string,
  secrets: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(secrets)
    .filter(([, value]) => value.length > 0)
    .sort(([, a], [, b]) => b.length - a.length);
  if (entries.length === 0) return input;

  const values = new Map(entries.map(([name, value]) => [value, name]));
  const pattern = new RegExp(
    entries.map(([, value]) => escapeRegExp(value)).join("|"),
    "g",
  );
  return input.replace(pattern, (value) => {
    const name = values.get(value) ?? "SECRET";
    const marker = `${name}=<REDACTED>`;
    if (!entries.some(([, secret]) => marker.includes(secret))) return marker;
    return entries.some(([, secret]) => "<REDACTED>".includes(secret))
      ? ""
      : "<REDACTED>";
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
