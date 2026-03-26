/**
 * Server-backed secret storage for Letta Code.
 * Secrets are stored on the Letta server via the agent secrets API
 * and cached in memory for fast $SECRET_NAME substitution in shell commands.
 */

import { getClient } from "../agent/client";
import { getCurrentAgentId } from "../agent/context";

/** In-memory cache of secrets (populated on startup from server).
 *  Stored on globalThis via Symbol.for() to survive Bun bundle duplication. */
const SECRETS_CACHE_KEY = Symbol.for("@letta/secretsCache");
type GlobalWithSecrets = typeof globalThis & {
  [key: symbol]: Record<string, string> | null;
};
function getCache(): Record<string, string> | null {
  return (globalThis as GlobalWithSecrets)[SECRETS_CACHE_KEY] ?? null;
}
function setCache(secrets: Record<string, string> | null): void {
  (globalThis as GlobalWithSecrets)[SECRETS_CACHE_KEY] = secrets;
}

/**
 * Initialize secrets from the server. Call on agent startup.
 * Fetches secrets via GET /v1/agents/{agent_id}?include=agent.secrets
 * and populates the in-memory cache.
 */
export async function initSecretsFromServer(agentId: string): Promise<void> {
  const client = await getClient();

  const agent = await client.agents.retrieve(agentId, {
    include: ["agent.secrets"],
  });

  const secrets: Record<string, string> = {};
  if (agent.secrets && Array.isArray(agent.secrets)) {
    for (const env of agent.secrets) {
      if (env.key && env.value) {
        secrets[env.key] = env.value;
      }
    }
  }

  setCache(secrets);
}

/**
 * Load secrets from the in-memory cache.
 * Returns an empty object if secrets have not been initialized yet.
 */
export function loadSecrets(): Record<string, string> {
  return getCache() ?? {};
}

/**
 * List all secret names (not values).
 */
export function listSecretNames(): string[] {
  return Object.keys(loadSecrets()).sort();
}

/**
 * Set a secret on the server and update the in-memory cache.
 * PATCH replaces the entire secrets map, so we rebuild from cache.
 */
export async function setSecretOnServer(
  key: string,
  value: string,
): Promise<void> {
  const client = await getClient();
  const agentId = getCurrentAgentId();

  // Update cache first
  const secrets = { ...loadSecrets() };
  secrets[key] = value;

  // PATCH replaces entire map
  await client.agents.update(agentId, { secrets });

  setCache(secrets);
}

/**
 * Delete a secret from the server and update the in-memory cache.
 * Rebuilds the map without the key and PATCHes.
 * @returns true if the secret existed and was deleted
 */
export async function deleteSecretOnServer(key: string): Promise<boolean> {
  const secrets = { ...loadSecrets() };

  if (!(key in secrets)) {
    return false;
  }

  delete secrets[key];

  const client = await getClient();
  const agentId = getCurrentAgentId();

  await client.agents.update(agentId, { secrets });

  setCache(secrets);
  return true;
}

/**
 * Clear the in-memory cache (useful for testing).
 */
export function clearSecretsCache(): void {
  setCache(null);
}
