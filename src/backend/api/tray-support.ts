import { isLocalAgentId } from "@/agent/agent-id";
import { getBackend } from "@/backend";
import { apiFetch, getApiRequestConfig } from "./request";

const SUPPORT_CACHE_TTL_MS = 30_000;

interface SupportCacheEntry {
  expiresAt: number;
  value: Promise<boolean>;
}

const supportCache = new Map<string, SupportCacheEntry>();

async function probeTrayRoute(agentId: string): Promise<boolean> {
  const { baseUrl, apiKey } = await getApiRequestConfig();
  const key = `${baseUrl}|${agentId}`;
  const cached = supportCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const value = (async () => {
    try {
      const response = await apiFetch(
        `/v1/agents/${encodeURIComponent(agentId)}/conversations/default/tray`,
        { baseUrl, apiKey },
      );
      await response.body?.cancel();
      return response.status !== 404 && response.status !== 405;
    } catch {
      return false;
    }
  })();
  supportCache.set(key, {
    expiresAt: Date.now() + SUPPORT_CACHE_TTL_MS,
    value,
  });
  return value;
}

/** Resolve Tray support consistently for discovery and direct Skill loading. */
export async function resolveTrayFeatureAvailability(
  agentId: string | undefined,
  override?: boolean,
): Promise<boolean> {
  if (override !== undefined) return override;
  if (!agentId || isLocalAgentId(agentId)) return false;

  const capabilities = getBackend().capabilities;
  if (capabilities.localMemfs) return false;
  if (capabilities.environmentRouting) return true;
  return probeTrayRoute(agentId);
}

export function clearTraySupportCacheForTests(): void {
  supportCache.clear();
}
