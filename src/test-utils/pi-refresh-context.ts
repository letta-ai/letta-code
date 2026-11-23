import type {
  ModelsStoreEntry,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";

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
