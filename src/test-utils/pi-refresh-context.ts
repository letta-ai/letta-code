import type { RefreshModelsContext } from "@earendil-works/pi-ai";

/**
 * Minimal pi-ai RefreshModelsContext for driving `provider.refreshModels()`
 * directly in tests (production refreshes go through the Models runtime,
 * which supplies a real store-backed context).
 */
export function testRefreshContext(): RefreshModelsContext {
  const entries = new Map<string, unknown>();
  return {
    allowNetwork: true,
    force: true,
    store: {
      read: async () =>
        entries.get("entry") as
          | Awaited<ReturnType<RefreshModelsContext["store"]["read"]>>
          | undefined,
      write: async (entry) => {
        entries.set("entry", entry);
      },
      delete: async () => {
        entries.delete("entry");
      },
    },
  };
}
