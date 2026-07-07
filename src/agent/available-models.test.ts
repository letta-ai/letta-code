import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Cache semantics for the listener's model-availability cache (LET-9479).
 *
 * Two staleness bugs made "no models after connecting a provider" stick for
 * the full 5-minute TTL:
 *  1. `clearAvailableModelsCache()` cleared `cache` but not `inflight`, so a
 *     fetch that started BEFORE a provider connect could complete afterward
 *     and commit its pre-connect (empty) handle set as a fresh cache entry.
 *  2. There was no force path: user-initiated refreshes were always eligible
 *     to be answered from a stale-but-within-TTL snapshot.
 *
 * Note: `mock.module` is process-global under Bun, so this file only mocks
 * modules that no other behavior in this suite depends on.
 */

type FakeModel = {
  handle: string;
  max_context_window?: number;
  provider_type?: string;
};

let listModelsImpl: () => Promise<FakeModel[]> = async () => [];

mock.module("@/backend", () => ({
  getBackend: () => ({
    capabilities: { byokProviderRefresh: false },
    listModels: () => listModelsImpl(),
  }),
}));

mock.module("@/backend/api/providers", () => ({
  refreshByokProviders: async () => {
    throw new Error("refreshByokProviders must not run without capability");
  },
}));

const {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getCachedModelHandles,
} = await import("@/agent/available-models");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("available-models cache semantics", () => {
  beforeEach(() => {
    clearAvailableModelsCache();
    listModelsImpl = async () => [];
  });

  test("a fetch that started before a cache clear cannot commit stale results", async () => {
    const preConnect = deferred<FakeModel[]>();
    listModelsImpl = () => preConnect.promise;

    // Fetch A starts (e.g. boot-time list_models before any provider exists).
    const fetchA = getAvailableModelHandles();

    // Provider connect clears the cache while A is still in flight.
    clearAvailableModelsCache();

    // Fetch B starts post-connect and sees the new provider's models.
    const postConnect = deferred<FakeModel[]>();
    listModelsImpl = () => postConnect.promise;
    const fetchB = getAvailableModelHandles();

    // A resolves late with the pre-connect (empty) snapshot.
    preConnect.resolve([]);
    await fetchA;

    // The stale result must not have been committed to the cache.
    expect(getCachedModelHandles()).toBeNull();

    postConnect.resolve([{ handle: "openai/gpt-4o" }]);
    const resultB = await fetchB;
    expect([...resultB.handles]).toEqual(["openai/gpt-4o"]);

    // B's result is the cached truth — and A's late `.finally` must not have
    // nulled out B's inflight slot mid-fetch either.
    expect([...(getCachedModelHandles() ?? [])]).toEqual(["openai/gpt-4o"]);

    // Subsequent calls serve B's committed cache entry.
    listModelsImpl = async () => {
      throw new Error("must be served from cache");
    };
    const cached = await getAvailableModelHandles();
    expect(cached.source).toBe("cache");
    expect([...cached.handles]).toEqual(["openai/gpt-4o"]);
  });

  test("forceRefresh bypasses a fresh cache entry", async () => {
    listModelsImpl = async () => [{ handle: "openai/gpt-4o" }];
    const first = await getAvailableModelHandles();
    expect([...first.handles]).toEqual(["openai/gpt-4o"]);

    // Cache is fresh: a normal call must serve it.
    listModelsImpl = async () => [
      { handle: "openai/gpt-4o" },
      { handle: "zai/glm-4.6" },
    ];
    const cached = await getAvailableModelHandles();
    expect(cached.source).toBe("cache");
    expect([...cached.handles]).toEqual(["openai/gpt-4o"]);

    // Force refresh must hit the network despite the fresh cache.
    const forced = await getAvailableModelHandles({ forceRefresh: true });
    expect(forced.source).toBe("network");
    expect([...forced.handles]).toEqual(["openai/gpt-4o", "zai/glm-4.6"]);
  });

  test("clearAvailableModelsCache drops the inflight fetch so the next call refetches", async () => {
    const wedged = deferred<FakeModel[]>();
    listModelsImpl = () => wedged.promise;
    const fetchA = getAvailableModelHandles();

    clearAvailableModelsCache();

    // Next caller must start a fresh fetch instead of piggybacking on A.
    listModelsImpl = async () => [{ handle: "anthropic/claude-sonnet-4-5" }];
    const resultB = await getAvailableModelHandles();
    expect([...resultB.handles]).toEqual(["anthropic/claude-sonnet-4-5"]);

    wedged.resolve([]);
    await fetchA;
    expect([...(getCachedModelHandles() ?? [])]).toEqual([
      "anthropic/claude-sonnet-4-5",
    ]);
  });
});
