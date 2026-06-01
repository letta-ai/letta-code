import type { MessageSearchResponse } from "@letta-ai/letta-client/resources/messages";
import { searchMessages, warmSearchCache } from "./api/search";
import { type Backend, getBackend } from "./backend";
import { getLocalBackendStorageDir } from "./local/paths";
import {
  type LocalTranscriptSearchBody,
  searchLocalTranscriptMessages,
} from "./local/transcript-search";

type SearchMode = "vector" | "fts" | "hybrid";

type MessageSearchBody = LocalTranscriptSearchBody;

function localStorageDirForBackend(backend: Backend): string {
  return backend.getLocalStorageDir?.() ?? getLocalBackendStorageDir();
}

export async function searchMessagesForBackend<T = MessageSearchResponse>(
  body: MessageSearchBody,
  backend: Backend = getBackend(),
): Promise<T> {
  if (backend.capabilities.localModelCatalog) {
    return searchLocalTranscriptMessages(
      localStorageDirForBackend(backend),
      body,
    ) as T;
  }

  return searchMessages<T>({
    ...body,
    search_mode:
      body.search_mode === "vector" ||
      body.search_mode === "fts" ||
      body.search_mode === "hybrid"
        ? (body.search_mode as SearchMode)
        : body.search_mode,
  } as Record<string, unknown>);
}

export async function warmMessageSearchCacheForBackend<T>(
  body: Record<string, unknown>,
  backend: Backend = getBackend(),
): Promise<T> {
  if (backend.capabilities.localModelCatalog) {
    return {
      collection: body.collection ?? "messages",
      status: "local-backend-noop",
      warmed: false,
    } as T;
  }
  return warmSearchCache<T>(body);
}
