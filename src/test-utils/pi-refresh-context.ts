import type {
  ModelsStoreEntry,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";

/**
 * Minimal pi-ai RefreshModelsContext for driving `provider.refreshModels()`
 * directly in tests (production refreshes go through the Models runtime,
 * which supplies a real store-backed context).
 *
 * pi-ai 0.84+: the old mutable `store` API was replaced by an immutable
 * `stored` snapshot plus generation-checked `publish()`.
 */
export function testRefreshContext(
  stored?: Readonly<ModelsStoreEntry>,
): RefreshModelsContext {
  let current = stored;
  return {
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    get stored() {
      return current;
    },
    publish: async (publication) => {
      if (publication.persist !== undefined) {
        current = publication.persist ?? undefined;
      }
      publication.update?.();
      return true;
    },
  };
}
