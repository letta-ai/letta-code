/**
 * Agent-scoped secret storage for Letta Code.
 * Cloud agent secrets are stored on the Letta server. Local agent secrets are
 * stored in the operating system credential manager when available, with a
 * local-backend file fallback for Node production. Both paths hydrate the same
 * in-memory cache for fast $SECRET_NAME substitution.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLocalAgentId } from "@/agent/agent-id";
import { getCurrentAgentId } from "@/agent/context";
import { getBackend } from "@/backend";
import { getLocalBackendStorageDir } from "@/backend/local/paths";
import {
  deleteSecretValue,
  getSecretValue,
  isKeychainAvailable,
  setSecretValue,
} from "@/utils/secrets";

type SecretsBackend = {
  capabilities: { serverSecrets: boolean };
  retrieveAgent: (
    agentId: string,
    options?: { include?: string[] },
  ) => Promise<{ secrets?: Array<{ key?: string; value?: string }> | null }>;
  updateAgent: (
    agentId: string,
    body: { secrets: Record<string, string> },
  ) => Promise<unknown>;
};

type LocalSecretStorage = {
  delete: (name: string) => Promise<boolean>;
  get: (name: string, label: string) => Promise<string | null>;
  set: (name: string, value: string) => Promise<void>;
};

let testBackendOverride: SecretsBackend | null = null;
let testLocalSecretStorageOverride: LocalSecretStorage | null = null;

export function __testOverrideSecretsBackend(
  backend: SecretsBackend | null,
): void {
  testBackendOverride = backend;
}

export function __testOverrideLocalSecretStorage(
  storage: LocalSecretStorage | null,
): void {
  testLocalSecretStorageOverride = storage;
}

function getSecretsBackend(): SecretsBackend {
  return testBackendOverride ?? (getBackend() as SecretsBackend);
}

const FILE_BACKED_LOCAL_SECRETS_PATH = join(
  "secrets",
  "local-agent-secrets.json",
);

type FileBackedLocalSecrets = {
  secrets?: Record<string, string>;
};

function getFileBackedLocalSecretsPath(): string {
  return join(getLocalBackendStorageDir(), FILE_BACKED_LOCAL_SECRETS_PATH);
}

function readFileBackedLocalSecrets(): Record<string, string> {
  const filePath = getFileBackedLocalSecretsPath();
  if (!existsSync(filePath)) return {};

  try {
    const parsed = JSON.parse(
      readFileSync(filePath, "utf8"),
    ) as FileBackedLocalSecrets;
    if (!parsed.secrets || typeof parsed.secrets !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed.secrets).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeFileBackedLocalSecrets(secrets: Record<string, string>): void {
  const filePath = getFileBackedLocalSecretsPath();
  mkdirSync(dirname(filePath), { mode: 0o700, recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ secrets }, null, 2)}\n`, {
    encoding: "utf8",
    flush: true,
    mode: 0o600,
  });
}

function getFileBackedLocalSecret(name: string): string | null {
  return readFileBackedLocalSecrets()[name] ?? null;
}

function setFileBackedLocalSecret(name: string, value: string): void {
  const secrets = readFileBackedLocalSecrets();
  secrets[name] = value;
  writeFileBackedLocalSecrets(secrets);
}

function deleteFileBackedLocalSecret(name: string): boolean {
  const secrets = readFileBackedLocalSecrets();
  if (!(name in secrets)) return false;
  delete secrets[name];
  writeFileBackedLocalSecrets(secrets);
  return true;
}

async function getAutoLocalSecretValue(
  name: string,
  label: string,
): Promise<string | null> {
  if (await isKeychainAvailable()) {
    const value = await getSecretValue(name, label);
    if (value !== null) return value;
  }
  return getFileBackedLocalSecret(name);
}

async function setAutoLocalSecretValue(
  name: string,
  value: string,
): Promise<void> {
  if (await isKeychainAvailable()) {
    try {
      await setSecretValue(name, value);
      return;
    } catch {
      // Fall through to file storage if keychain writes fail after probing.
    }
  }

  setFileBackedLocalSecret(name, value);
}

async function deleteAutoLocalSecretValue(name: string): Promise<boolean> {
  let deleted = false;
  if (await isKeychainAvailable()) {
    deleted = await deleteSecretValue(name);
  }

  return deleteFileBackedLocalSecret(name) || deleted;
}

function getLocalSecretStorage(): LocalSecretStorage {
  return (
    testLocalSecretStorageOverride ?? {
      delete: deleteAutoLocalSecretValue,
      get: getAutoLocalSecretValue,
      set: setAutoLocalSecretValue,
    }
  );
}

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

const LOCAL_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function localSecretIndexName(agentId: string): string {
  return `agent:${agentId}:secrets:index`;
}

function localSecretValueName(agentId: string, key: string): string {
  return `agent:${agentId}:secrets:${key}`;
}

function normalizeSecretNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Local agent secret index is invalid.");
  }

  return [...new Set(value)]
    .filter(
      (name): name is string =>
        typeof name === "string" && LOCAL_SECRET_NAME_PATTERN.test(name),
    )
    .sort();
}

function normalizeSecretKey(key: string): string {
  const normalized = key.toUpperCase();
  if (!LOCAL_SECRET_NAME_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid secret name '${key}'. Use uppercase letters, numbers, and underscores only. Must start with a letter or underscore.`,
    );
  }
  return normalized;
}

function normalizeSecretMutations(options: {
  set?: Record<string, string>;
  unset?: string[];
}): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(options.set ?? {})) {
    set[normalizeSecretKey(rawKey)] = value;
  }
  const unset = (options.unset ?? []).map(normalizeSecretKey);
  return { set, unset };
}

async function loadLocalSecretNames(agentId: string): Promise<string[]> {
  const raw = await getLocalSecretStorage().get(
    localSecretIndexName(agentId),
    "local agent secret index",
  );
  if (!raw) return [];

  try {
    return normalizeSecretNames(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Local agent secret index is invalid.");
  }
}

async function storeLocalSecretNames(
  agentId: string,
  names: string[],
): Promise<void> {
  await getLocalSecretStorage().set(
    localSecretIndexName(agentId),
    JSON.stringify(normalizeSecretNames(names)),
  );
}

async function loadLocalAgentSecrets(
  agentId: string,
): Promise<Record<string, string>> {
  const names = await loadLocalSecretNames(agentId);
  const secrets: Record<string, string> = {};

  for (const name of names) {
    const value = await getLocalSecretStorage().get(
      localSecretValueName(agentId, name),
      `local agent secret ${name}`,
    );
    if (value !== null) {
      secrets[name] = value;
    }
  }

  return secrets;
}

async function setLocalAgentSecret(
  agentId: string,
  key: string,
  value: string,
): Promise<void> {
  const secrets = await loadLocalAgentSecrets(agentId);
  await getLocalSecretStorage().set(localSecretValueName(agentId, key), value);
  secrets[key] = value;
  await storeLocalSecretNames(agentId, Object.keys(secrets));
  setCache(agentId, secrets);
}

async function deleteLocalAgentSecret(
  agentId: string,
  key: string,
): Promise<boolean> {
  const secrets = await loadLocalAgentSecrets(agentId);
  if (!(key in secrets)) return false;

  const deleted = await getLocalSecretStorage().delete(
    localSecretValueName(agentId, key),
  );
  if (!deleted) return false;

  delete secrets[key];
  await storeLocalSecretNames(agentId, Object.keys(secrets));
  setCache(agentId, secrets);
  return true;
}

async function applyLocalSecretBatch(
  agentId: string,
  options: { set?: Record<string, string>; unset?: string[] },
): Promise<string[]> {
  const normalized = normalizeSecretMutations(options);
  const secrets = await loadLocalAgentSecrets(agentId);

  for (const [key, value] of Object.entries(normalized.set)) {
    await getLocalSecretStorage().set(
      localSecretValueName(agentId, key),
      value,
    );
    secrets[key] = value;
  }
  for (const key of normalized.unset) {
    if (key in secrets) {
      await getLocalSecretStorage().delete(localSecretValueName(agentId, key));
      delete secrets[key];
    }
  }

  const names = Object.keys(secrets).sort();
  await storeLocalSecretNames(agentId, names);
  setCache(agentId, secrets);
  return names;
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
 * Initialize the agent-scoped secrets cache. Cloud agents fetch from the
 * server. Local agents read from OS secure storage through Bun.secrets.
 */
export async function initSecretsFromServer(
  agentId: string,
  cachedAgent?: { secrets?: Array<{ key?: string; value?: string }> | null },
): Promise<void> {
  if (isLocalAgentId(agentId)) {
    setCache(agentId, await loadLocalAgentSecrets(agentId));
    return;
  }

  const backend = getSecretsBackend();
  if (!cachedAgent && !backend.capabilities.serverSecrets) {
    setCache(agentId, {});
    return;
  }
  const agent =
    cachedAgent ??
    (await backend.retrieveAgent(agentId, {
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
 * Apply a batch of secret mutations. Cloud agents use a single server PATCH;
 * local agents update OS secure storage and the local key index. Used by the
 * modal's `secret_apply` WS handler.
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

  const normalized = normalizeSecretMutations(options);

  if (isLocalAgentId(agentId)) {
    return applyLocalSecretBatch(agentId, normalized);
  }

  const backend = getSecretsBackend();
  if (!backend.capabilities.serverSecrets) {
    throw new Error("Agent secrets are not supported by this backend yet");
  }

  const next: Record<string, string> = { ...loadSecrets(agentId) };
  for (const [key, value] of Object.entries(normalized.set)) {
    next[key] = value;
  }
  for (const key of normalized.unset) {
    delete next[key];
  }

  await backend.updateAgent(agentId, { secrets: next });
  setCache(agentId, next);

  return Object.keys(next).sort();
}

/**
 * Set an agent-scoped secret and update the in-memory cache.
 */
export async function setSecretOnServer(
  key: string,
  value: string,
  agentIdArg?: string,
): Promise<void> {
  const agentId = resolveSecretsAgentId(agentIdArg);
  if (!agentId) {
    throw new Error("No agent context set. Agent ID is required.");
  }

  const normalizedKey = normalizeSecretKey(key);

  if (isLocalAgentId(agentId)) {
    await setLocalAgentSecret(agentId, normalizedKey, value);
    return;
  }

  const backend = getSecretsBackend();
  if (!backend.capabilities.serverSecrets) {
    throw new Error("Agent secrets are not supported by this backend yet");
  }

  await initSecretsFromServer(agentId);

  // Update cache first
  const secrets = { ...loadSecrets(agentId) };
  secrets[normalizedKey] = value;

  // PATCH replaces entire map
  await backend.updateAgent(agentId, { secrets });

  setCache(agentId, secrets);
}

/**
 * Delete an agent-scoped secret and update the in-memory cache.
 * @returns true if the secret existed and was deleted
 */
export async function deleteSecretOnServer(
  key: string,
  agentIdArg?: string,
): Promise<boolean> {
  const agentId = resolveSecretsAgentId(agentIdArg);
  if (!agentId) {
    throw new Error("No agent context set. Agent ID is required.");
  }

  const normalizedKey = normalizeSecretKey(key);

  if (isLocalAgentId(agentId)) {
    return deleteLocalAgentSecret(agentId, normalizedKey);
  }

  const backend = getSecretsBackend();
  if (!backend.capabilities.serverSecrets) {
    throw new Error("Agent secrets are not supported by this backend yet");
  }

  await initSecretsFromServer(agentId);

  const secrets = { ...loadSecrets(agentId) };

  if (!(normalizedKey in secrets)) {
    return false;
  }

  delete secrets[normalizedKey];

  await backend.updateAgent(agentId, { secrets });

  setCache(agentId, secrets);
  return true;
}

/**
 * Clear the in-memory cache (useful for testing).
 */
export function clearSecretsCache(agentId?: string | null): void {
  if (agentId === null) {
    getCache().clear();
    return;
  }
  const resolvedAgentId = resolveSecretsAgentId(agentId);
  if (resolvedAgentId) {
    getCache().delete(resolvedAgentId);
    return;
  }
  getCache().clear();
}
