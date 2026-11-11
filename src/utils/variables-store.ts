/** Plain agent variables are intentionally kept out of secret storage and redaction. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLocalAgentId } from "@/agent/agent-id";
import { getCurrentAgentId } from "@/agent/context";
import { type ApiRequestMethod, apiRequest } from "@/backend/api/request";
import { getLocalBackendStorageDir } from "@/backend/local/paths";

type Variables = Record<string, string>;
type Request = <T>(
  method: ApiRequestMethod,
  path: string,
  body?: Record<string, unknown>,
) => Promise<T>;
const CACHE_KEY = Symbol.for("@letta/variablesCache");
const globalCache = globalThis as typeof globalThis & {
  [CACHE_KEY]?: {
    values: Map<string, { values: Variables; loadedAt: number }>;
    links: Map<string, string>;
  };
};
globalCache[CACHE_KEY] ??= { values: new Map(), links: new Map() };
const { values: cache, links } = globalCache[CACHE_KEY];
let request: Request = apiRequest;

export function __testOverrideVariablesRequest(value: Request | null): void {
  request = value ?? apiRequest;
  cache.clear();
}

function resolveAgentId(id?: string): string {
  if (id) return id;
  try {
    return getCurrentAgentId();
  } catch {
    const fallback = process.env.LETTA_AGENT_ID || process.env.AGENT_ID;
    if (fallback) return fallback;
    throw new Error("No agent context set. Agent ID is required.");
  }
}

function localPath(id: string): string {
  return join(
    getLocalBackendStorageDir(),
    `variables-${encodeURIComponent(id)}.json`,
  );
}

function readLocal(id: string): Variables {
  try {
    const value: unknown = JSON.parse(readFileSync(localPath(id), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid variables file");
    return Object.fromEntries(
      Object.entries(value).filter(
        ([key, value]) =>
          /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === "string",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function route(id: string, key?: string): string {
  return `/v1/agents/${encodeURIComponent(id)}/variables${key === undefined ? "" : `/${encodeURIComponent(key)}`}`;
}

export function linkVariablesVault(id: string, parent: string): void {
  links.set(id, parent);
}

export function loadVariables(id?: string): Variables {
  const resolved = resolveAgentId(id);
  return { ...cache.get(links.get(resolved) ?? resolved)?.values };
}

export async function refreshAndListVariables(
  id?: string,
): Promise<Array<{ key: string; value: string }>> {
  const resolved = resolveAgentId(id);
  const target = links.get(resolved) ?? resolved;
  let values: Variables;
  if (isLocalAgentId(target)) values = readLocal(target);
  else {
    try {
      const entries = await request<Array<{ key: string; value: string }>>(
        "GET",
        route(target),
      );
      values = Object.fromEntries(
        entries.map(({ key, value }) => [key, value]),
      );
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      values = {};
    }
  }
  cache.set(target, { values, loadedAt: Date.now() });
  return Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
}

export async function ensureVariablesLoaded(id?: string): Promise<void> {
  const resolved = resolveAgentId(id);
  const entry = cache.get(links.get(resolved) ?? resolved);
  if (!entry || Date.now() - entry.loadedAt >= 60_000)
    await refreshAndListVariables(resolved);
}

async function mutate(
  key: string,
  value: string | undefined,
  id?: string,
  restrictToMe?: boolean,
): Promise<void> {
  const resolved = resolveAgentId(id);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
    throw new Error(
      "Invalid variable name. Use uppercase letters, numbers, and underscores; start with a letter or underscore.",
    );
  if (isLocalAgentId(resolved)) {
    const values = readLocal(resolved);
    if (value === undefined) delete values[key];
    else values[key] = value;
    mkdirSync(getLocalBackendStorageDir(), { recursive: true, mode: 0o700 });
    writeFileSync(localPath(resolved), `${JSON.stringify(values, null, 2)}\n`, {
      mode: 0o600,
    });
    cache.set(resolved, { values, loadedAt: Date.now() });
  } else {
    await request(
      value === undefined ? "DELETE" : "PUT",
      route(resolved, key),
      value === undefined
        ? undefined
        : {
            value,
            ...(restrictToMe === undefined
              ? {}
              : { restrict_to_me: restrictToMe }),
          },
    );
    cache.delete(resolved);
  }
}

export async function setVariableOnServer(
  key: string,
  value: string,
  id?: string,
  restrictToMe?: boolean,
): Promise<void> {
  await mutate(key.toUpperCase(), value, id, restrictToMe);
}

export async function deleteVariableOnServer(
  key: string,
  id?: string,
): Promise<boolean> {
  await mutate(key.toUpperCase(), undefined, id);
  return true;
}
