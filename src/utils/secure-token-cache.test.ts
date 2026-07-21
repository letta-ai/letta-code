import { describe, expect, test } from "bun:test";
import { SecureTokenCache } from "./secure-token-cache";

describe("SecureTokenCache", () => {
  test("single-flights hydration and reuses the result", async () => {
    const cache = new SecureTokenCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      await Promise.resolve();
      return {
        complete: true,
        tokens: { apiKey: "sk-cached", refreshToken: "rt-cached" },
      };
    };

    const results = await Promise.all([
      cache.hydrateOnce(true, load),
      cache.hydrateOnce(true, load),
      cache.hydrateOnce(true, load),
    ]);
    await cache.hydrateOnce(true, load);

    expect(loads).toBe(1);
    expect(results).toEqual([
      { apiKey: "sk-cached", refreshToken: "rt-cached" },
      { apiKey: "sk-cached", refreshToken: "rt-cached" },
      { apiKey: "sk-cached", refreshToken: "rt-cached" },
    ]);
  });

  test("does not apply stale hydration after an explicit cache update", async () => {
    const cache = new SecureTokenCache();
    let resolveLoad: ((tokens: { apiKey: string }) => void) | undefined;
    const hydration = cache.hydrateOnce(
      true,
      () =>
        new Promise((resolve) => {
          resolveLoad = (tokens) => resolve({ complete: true, tokens });
        }),
    );

    cache.update({ apiKey: "sk-new" });
    resolveLoad?.({ apiKey: "sk-stale" });

    expect(await hydration).toEqual({ apiKey: "sk-new" });
    expect(cache.get()).toEqual({ apiKey: "sk-new" });
  });

  test("skips hydration when secure storage is disabled", async () => {
    const cache = new SecureTokenCache();
    let loads = 0;

    expect(
      await cache.hydrateOnce(false, async () => {
        loads += 1;
        return { complete: true, tokens: { apiKey: "must-not-load" } };
      }),
    ).toEqual({});
    expect(loads).toBe(0);
  });

  test("retries one incomplete hydration and then stops", async () => {
    const cache = new SecureTokenCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return loads === 1
        ? { complete: false, tokens: {} }
        : { complete: false, tokens: { refreshToken: "rt-recovered" } };
    };

    expect(await cache.hydrateOnce(true, load)).toEqual({});
    expect(await cache.hydrateOnce(true, load)).toEqual({
      refreshToken: "rt-recovered",
    });
    await cache.hydrateOnce(true, load);

    expect(loads).toBe(2);
  });
});
