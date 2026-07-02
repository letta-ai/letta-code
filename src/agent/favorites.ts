import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { isLocalAgentId } from "@/agent/agent-id";
import { type Backend, getBackend } from "@/backend";
import { apiRequest } from "@/backend/api/request";
import { settingsManager } from "@/settings-manager";

export const LETTA_CHAT_FAVORITE_TAG_BASE = "view:letta-chat";
export const LETTA_CHAT_FAVORITE_TAG_PREFIX = "favorite:user:";
export const LOCAL_FAVORITE_OWNER_ID = "local";
export const LOCAL_DESKTOP_FAVORITE_TAG = generateFavoriteTag(
  LOCAL_FAVORITE_OWNER_ID,
);

interface CurrentUserMetadata {
  id?: unknown;
}

type CurrentUserMetadataFetcher = () => Promise<CurrentUserMetadata>;

let currentUserMetadataFetcherOverride: CurrentUserMetadataFetcher | null =
  null;

export function __testSetCurrentUserMetadataFetcher(
  fetcher: CurrentUserMetadataFetcher | null,
): void {
  currentUserMetadataFetcherOverride = fetcher;
}

export function generateFavoriteTag(ownerId: string): string {
  return `${LETTA_CHAT_FAVORITE_TAG_PREFIX}${ownerId}`;
}

async function fetchCurrentUserMetadata(): Promise<CurrentUserMetadata> {
  if (currentUserMetadataFetcherOverride) {
    return currentUserMetadataFetcherOverride();
  }
  return apiRequest<CurrentUserMetadata>("GET", "/v1/metadata/user");
}

export async function getCurrentCloudFavoriteTag(): Promise<string | null> {
  try {
    const user = await fetchCurrentUserMetadata();
    return typeof user.id === "string" && user.id
      ? generateFavoriteTag(user.id)
      : null;
  } catch {
    return null;
  }
}

export async function getFavoriteTagForAgent(
  agentId: string,
): Promise<string | null> {
  if (isLocalAgentId(agentId)) {
    return LOCAL_DESKTOP_FAVORITE_TAG;
  }
  return getCurrentCloudFavoriteTag();
}

export function getAgentTags(agent: Pick<AgentState, "tags">): string[] {
  return Array.isArray(agent.tags) ? agent.tags : [];
}

export function addFavoriteTag(tags: string[], favoriteTag: string): string[] {
  if (tags.includes(favoriteTag)) return tags;
  return [favoriteTag, ...tags];
}

export function removeFavoriteTag(
  tags: string[],
  favoriteTag: string,
): string[] {
  return tags.filter(
    (tag) => tag !== favoriteTag && tag !== LETTA_CHAT_FAVORITE_TAG_BASE,
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export type FavoriteMutationStatus = "changed" | "unchanged" | "unavailable";

export async function setAgentFavoriteTag(
  backend: Backend,
  agentId: string,
): Promise<FavoriteMutationStatus> {
  const favoriteTag = await getFavoriteTagForAgent(agentId);
  if (!favoriteTag) return "unavailable";

  const agent = await backend.retrieveAgent(agentId, {
    include: ["agent.tags"],
  });
  const tags = getAgentTags(agent);
  const nextTags = addFavoriteTag(tags, favoriteTag);
  if (arraysEqual(tags, nextTags)) return "unchanged";

  await backend.updateAgent(agentId, { tags: nextTags });
  return "changed";
}

export async function unsetAgentFavoriteTag(
  backend: Backend,
  agentId: string,
): Promise<FavoriteMutationStatus> {
  const favoriteTag = await getFavoriteTagForAgent(agentId);
  if (!favoriteTag) return "unavailable";

  const agent = await backend.retrieveAgent(agentId, {
    include: ["agent.tags"],
  });
  const tags = getAgentTags(agent);
  const nextTags = removeFavoriteTag(tags, favoriteTag);
  if (arraysEqual(tags, nextTags)) return "unchanged";

  await backend.updateAgent(agentId, { tags: nextTags });
  return "changed";
}

export type PinAgentStatus = "pinned" | "already-pinned";
export type UnpinAgentStatus = "unpinned" | "not-pinned";

export async function pinAgentForCurrentUser(
  agentId: string,
  backend: Backend = getBackend(),
): Promise<PinAgentStatus> {
  const wasPinnedInSettings = settingsManager.isAgentPinned(agentId);

  try {
    const result = await setAgentFavoriteTag(backend, agentId);
    if (result !== "unavailable") {
      if (wasPinnedInSettings) {
        settingsManager.unpinAgent(agentId);
      }
      return result === "unchanged" || wasPinnedInSettings
        ? "already-pinned"
        : "pinned";
    }
  } catch {
    // Fall back to legacy settings pins below.
  }

  if (wasPinnedInSettings) return "already-pinned";
  settingsManager.pinAgent(agentId);
  return "pinned";
}

export async function unpinAgentForCurrentUser(
  agentId: string,
  backend: Backend = getBackend(),
): Promise<UnpinAgentStatus> {
  const wasPinnedInSettings = settingsManager.isAgentPinned(agentId);

  try {
    const result = await unsetAgentFavoriteTag(backend, agentId);
    if (result !== "unavailable") {
      if (wasPinnedInSettings) {
        settingsManager.unpinAgent(agentId);
      }
      return result === "changed" || wasPinnedInSettings
        ? "unpinned"
        : "not-pinned";
    }
  } catch (error) {
    if (!wasPinnedInSettings) throw error;
    // Fall back to legacy settings pins below.
  }

  if (!wasPinnedInSettings) return "not-pinned";
  settingsManager.unpinAgent(agentId);
  return "unpinned";
}
