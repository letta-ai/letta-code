import { describe, expect, test } from "bun:test";
import {
  getProviderById,
  getProviderByName,
  listProviders,
  type ProviderResponse,
} from "@/backend/api/providers";
import { ApiRequestError, type apiRequest } from "@/backend/api/request";

function provider(
  id: string,
  name = id,
  overrides: Partial<ProviderResponse> = {},
): ProviderResponse {
  return {
    id,
    name,
    provider_type: "openai",
    provider_category: "byok",
    ...overrides,
  };
}

type RequestCall = Parameters<typeof apiRequest>;

function requestFrom(
  handler: (...args: RequestCall) => unknown,
): typeof apiRequest {
  return (async (...args: RequestCall) =>
    handler(...args)) as typeof apiRequest;
}

describe("provider resolution", () => {
  test("retrieves an exact provider ID without listing providers", async () => {
    const calls: RequestCall[] = [];
    const result = await getProviderById(
      "provider/one",
      requestFrom((...args) => {
        calls.push(args);
        return provider("provider/one", "lc-openai");
      }),
    );

    expect(result).toEqual(provider("provider/one", "lc-openai"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual([
      "GET",
      "/v1/providers/provider%2Fone",
    ]);
  });

  test("maps only point-read 404s to a missing provider", async () => {
    const missing = requestFrom(() => {
      throw new ApiRequestError("missing", 404, "");
    });
    const unavailable = requestFrom(() => {
      throw new ApiRequestError("unavailable", 503, "");
    });

    expect(await getProviderById("provider-missing", missing)).toBeNull();
    await expect(
      getProviderById("provider-unavailable", unavailable),
    ).rejects.toThrow("unavailable");
  });

  test("keeps base providers outside the BYOK point lookup", async () => {
    const request = requestFrom(() =>
      provider("provider-base", "openai", { provider_category: "base" }),
    );

    expect(await getProviderById("provider-base", request)).toBeNull();
  });

  test("paginates the complete provider collection", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      provider(`provider-${index}`),
    );
    const calls: RequestCall[] = [];
    const result = await listProviders(
      {},
      requestFrom((...args) => {
        calls.push(args);
        const after = args[3]?.query?.after;
        return after ? [provider("provider-50")] : firstPage;
      }),
    );

    expect(result).toHaveLength(51);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[3]?.query).toEqual({
      after: undefined,
      limit: 50,
    });
    expect(calls[1]?.[3]?.query).toEqual({
      after: "provider-49",
      limit: 50,
    });
  });

  test("keeps exact name lookup complete when filtering is unavailable", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      provider(`provider-${index}`, `other-${index}`),
    );
    const calls: RequestCall[] = [];
    const result = await getProviderByName(
      "target",
      requestFrom((...args) => {
        calls.push(args);
        const after = args[3]?.query?.after;
        return after ? [provider("provider-target", "target")] : firstPage;
      }),
    );

    expect(result).toEqual(provider("provider-target", "target"));
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call[3]?.query?.name === "target")).toBe(true);
  });
});
