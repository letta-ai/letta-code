/**
 * Server-backed secret storage for Letta Code.
 * Secrets are stored on the Letta server via the agent secrets API
 * and cached in memory for fast $SECRET_NAME substitution in shell commands.
 */

import { getCurrentAgentId } from "../agent/context";
import { getBackend } from "../backend";
import { getClient } from "../backend/api/client";

/** In-memory cache of secrets (populated on startup from server).
 *  Stored on globalThis via Symbol.for() to survive Bun bundle duplication. */
const SECRETS_CACHE_KEY = Symbol.for("@letta/secretsCache");
type SecretsCache = Map<string, Record<string, string>>;
type GlobalWithSecrets = typeof globalThis & {
  [key: symbol]: SecretsCache | undefined;
};
function getCache(): SecretsCache {
  const global = globalThis as GlobalWithSecrets;
  if (!global[SECRETS_CACHE_KEY]) {
    global[SECRETS_CACHE_KEY] = new Map();
  }
  return global[SECRETS_CACHE_KEY];
}

function setCache(agentId: string, secrets: Record<string, string>): void {
  getCache().set(agentId, { ...secrets });
}

function resolveSecretsAgentId(explicitAgentId?: string): string | null {
  const trimmedExplicit = explicitAgentId?.trim();
  if (trimmedExplicit) {
    return trimmedExplicit;
  }

  try {
    const scopedAgentId = getCurrentAgentId().trim();
    if (scopedAgentId) {
      return scopedAgentId;
    }
  } catch {
    // Fall through to env fallback below.
  }

  const envAgentId = (
    process.env.LETTA_AGENT_ID ||
    process.env.AGENT_ID ||
    ""
  ).trim();
  return envAgentId || null;
}

/**
 * Initialize secrets from the server. Call on agent startup.
 * Fetches secrets via GET /v1/agents/{agent_id}?include=agent.secrets
 * and populates the in-memory cache.
 */
export async function initSecretsFromServer(
  agentId: string,
  cachedAgent?: { secrets?: Array<{ key?: string; value?: string }> | null },
): Promise<void> {
  if (!cachedAgent && !getBackend().capabilities.serverSecrets) {
    setCache(agentId, {});
    return;
  }
  const agent =
    cachedAgent ??
    (await (
      await getClient()
    ).agents.retrieve(agentId, {
      include: ["agent.secrets"],
    }));

  const secrets: Record<string, string> = {};
  if (agent.secrets && Array.isArray(agent.secrets)) {
    for (const env of agent.secrets) {
      if (env.key && env.value) {
        secrets[env.key] = env.value;
      }
    }
  }

  setCache(agentId, secrets);
}

/**
 * Load secrets from the in-memory cache.
 * Returns an empty object if secrets have not been initialized yet.
 */
export function loadSecrets(agentId?: string): Record<string, string> {
  const resolvedAgentId = resolveSecretsAgentId(agentId);
  if (!resolvedAgentId) {
    return {};
  }
  return { ...(getCache().get(resolvedAgentId) ?? {}) };
}

/**
 * List all secret names (not values).
 */
export function listSecretNames(agentId?: string): string[] {
  return Object.keys(loadSecrets(agentId)).sort();
}

/**
 * Refresh the cache from core, then return the full entries. Used by the
 * modal's `secret_list` WS handler to pre-populate the form.
 */
export async function refreshAndListSecrets(
  agentIdArg?: string,
): Promise<Array<{ key: string; value: string }>> {
  const agentId = resolveSecretsAgentId(agentIdArg);
  if (!agentId) {
    throw new Error("No agent context set. Agent ID is required.");
  }
  await initSecretsFromServer(agentId);
  const cache = loadSecrets(agentId);
  return Object.keys(cache)
    .sort()
    .map((key) => ({ key, value: cache[key] ?? "" }));
}

/**
 * Apply a batch of mutations atomically: a single read + single PATCH that
 * overlays `set` and removes `unset`. Avoids the read-modify-write race when
 * multiple keys change at once. Used by the modal's `secret_apply` WS handler.
 *
 * @returns sorted final secret name list after the apply
 */
export async function applySecretBatch(
  options: {
    set?: Record<string, string>;
    unset?: string[];
  },
  agentIdArg?: string,
): Promise<string[]> {
  const agentId = resolveSecretsAgentId(agentIdArg);
  if (!agentId) {
    throw new Error("No agent context set. Agent ID is required.");
  }

  const next: Record<string, string> = { ...loadSecrets(agentId) };
  for (const [rawKey, value] of Object.entries(options.set ?? {})) {
    next[rawKey.toUpperCase()] = value;
  }
  for (const rawKey of options.unset ?? []) {
    delete next[rawKey.toUpperCase()];
  }

  const client = await getClient();
  await client.agents.update(agentId, { secrets: next });
  setCache(agentId, next);

  return Object.keys(next).sort();
}

/**
 * Set a secret on the server and update the in-memory cache.
 * PATCH replaces the entire secrets map, so we rebuild from cache.
 */
export async function setSecretOnServer(
  key: string,
  value: string,
  agentIdArg?: string,
): Promise<void> {
  if (!getBackend().capabilities.serverSecrets) {
    throw new Error("Agent secrets are not supported by this backend yet");
  }
  const client = await getClient();
  const agentId = resolveSecretsAgentId(agentIdArg);
  if (!agentId) {
    throw new Error("No agent context set. Agent ID is required.");
  }

  // Update cache first
  const secrets = { ...loadSecrets(agentId) };
  secrets[key] = value;

  // PATCH replaces entire map
  await client.agents.update(agentId, { secrets });

  setCache(agentId, secrets);
}

/**
 * Delete a secret from the server and update the in-memory cache.
 * Rebuilds the map without the key and PATCHes.
 * @returns true if the secret existed and was deleted
 */
export async function deleteSecretOnServer(
  key: string,
  agentIdArg?: string,
): Promise<boolean> {
  if (!getBackend().capabilities.serverSecrets) {
    throw new Error("Agent secrets are not supported by this backend yet");
  }
  const agentId = resolveSecretsAgentId(agentIdArg);
  if (!agentId) {
    throw new Error("No agent context set. Agent ID is required.");
  }
  const secrets = { ...loadSecrets(agentId) };

  if (!(key in secrets)) {
    return false;
  }

  delete secrets[key];

  const client = await getClient();

  await client.agents.update(agentId, { secrets });

  setCache(agentId, secrets);
  return true;
}

/**
 * Clear the in-memory cache (useful for testing).
 */
export function clearSecretsCache(agentId?: string): void {
  const resolvedAgentId = resolveSecretsAgentId(agentId);
  if (resolvedAgentId) {
    getCache().delete(resolvedAgentId);
    return;
  }
  getCache().clear();
}
