import { describe, expect, test } from "bun:test";
import type { ProviderResponse } from "@/backend/api/providers";
import { removeProviderById } from "@/providers/byok-providers";

function provider(id: string): ProviderResponse {
  return {
    id,
    name: "lc-openai",
    provider_type: "openai",
    provider_category: "byok",
  };
}

describe("known-ID provider removal", () => {
  test("uses point resolution and deletion without a list call", async () => {
    const calls: string[] = [];

    await removeProviderById(
      "provider-1",
      { target: "api" },
      {
        getById: async (id, options) => {
          calls.push(`get:${options?.target}:${id}`);
          return provider(id);
        },
        deleteById: async (id, options) => {
          calls.push(`delete:${options?.target}:${id}`);
        },
      },
    );

    expect(calls).toEqual(["get:api:provider-1", "delete:api:provider-1"]);
  });

  test("keeps missing providers as a no-op", async () => {
    let deleted = false;

    await removeProviderById(
      "provider-missing",
      { target: "local" },
      {
        getById: async () => null,
        deleteById: async () => {
          deleted = true;
        },
      },
    );

    expect(deleted).toBe(false);
  });

  test("propagates point-read authorization failures", async () => {
    let deleted = false;

    await expect(
      removeProviderById(
        "provider-forbidden",
        { target: "api" },
        {
          getById: async () => {
            throw new Error("forbidden");
          },
          deleteById: async () => {
            deleted = true;
          },
        },
      ),
    ).rejects.toThrow("forbidden");
    expect(deleted).toBe(false);
  });
});
