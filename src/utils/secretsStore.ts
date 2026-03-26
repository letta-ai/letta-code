/**
 * Server-backed secret storage for Letta Code.
 * Secrets are stored on the Letta server via the agent secrets API
 * and cached in memory for fast $SECRET_NAME substitution in shell commands.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getClient } from "../agent/client";

declare const process: { env: Record<string, string | undefined> };

/** In-memory cache of secrets (populated on startup from server). */
let cachedSecrets: Record<string, string> | null = null;

/** Stored agent ID, set during initialization. */
let storedAgentId: string | null = null;

/** Stored memory directory path, set during initialization. */
let storedMemoryDir: string | null = null;

/**
 * Get the agent ID (set during init, falls back to env).
 */
function getAgentId(): string {
  const agentId =
    storedAgentId || process.env.AGENT_ID || process.env.LETTA_AGENT_ID;
  if (!agentId) {
    throw new Error("No agent ID available — call initSecretsFromServer first");
  }
  return agentId;
}

/**
 * Initialize secrets from the server. Call on agent startup.
 * Fetches secrets via GET /v1/agents/{agent_id}?include=agent.secrets
 * and populates the in-memory cache.
 */
export async function initSecretsFromServer(
  agentId: string,
  memoryDir?: string,
): Promise<void> {
  storedAgentId = agentId;
  if (memoryDir) storedMemoryDir = memoryDir;
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

  cachedSecrets = secrets;
  // TODO: Come up with a better way to sync secrets than using a memory block.
  // syncSecretsToMemoryBlock();
}

/**
 * Load secrets from the in-memory cache.
 * Returns an empty object if secrets have not been initialized yet.
 */
export function loadSecrets(): Record<string, string> {
  return cachedSecrets ?? {};
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
  const agentId = getAgentId();

  // Update cache first
  const secrets = { ...loadSecrets() };
  secrets[key] = value;

  // PATCH replaces entire map
  await client.agents.update(agentId, { secrets });

  cachedSecrets = secrets;
  // TODO: Come up with a better way to sync secrets than using a memory block.
  // syncSecretsToMemoryBlock();
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
  const agentId = getAgentId();

  await client.agents.update(agentId, { secrets });

  cachedSecrets = secrets;
  // TODO: Come up with a better way to sync secrets than using a memory block.
  // syncSecretsToMemoryBlock();
  return true;
}

/**
 * Sync secret names to the memory block so the agent knows which secrets exist.
 * Writes to $MEMORY_DIR/system/secrets.md (names only, no values).
 */
function syncSecretsToMemoryBlock(): void {
  const memoryDir = storedMemoryDir || process.env.MEMORY_DIR;
  if (!memoryDir) return;

  const names = listSecretNames();
  const secretsFilePath = join(memoryDir, "system", "secrets.md");

  const description =
    names.length > 0
      ? "Available secrets for shell command substitution"
      : "No secrets configured";

  const body =
    names.length > 0
      ? `Use \`$SECRET_NAME\` syntax in shell commands to reference these secrets:\n\n${names.map((n) => `- \`$${n}\``).join("\n")}`
      : "";

  const rendered = `---
description: ${description}
---

## Available Secrets

${body}
`;

  const systemDir = dirname(secretsFilePath);
  if (!existsSync(systemDir)) {
    mkdirSync(systemDir, { recursive: true });
  }

  writeFileSync(secretsFilePath, rendered, "utf8");
}

/**
 * Clear the in-memory cache (useful for testing).
 */
export function clearSecretsCache(): void {
  cachedSecrets = null;
}
