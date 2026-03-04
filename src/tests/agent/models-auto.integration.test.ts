/**
 * Live API regression test for Cloud model availability.
 *
 * Runs only when:
 * - LETTA_API_KEY is set
 * - LETTA_BASE_URL points to Letta Cloud (api.letta.com)
 */

import { describe, expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";

const LETTA_API_KEY = process.env.LETTA_API_KEY;
const LETTA_BASE_URL = process.env.LETTA_BASE_URL || "https://api.letta.com";

function isCloudBaseUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "api.letta.com";
  } catch {
    return value.includes("api.letta.com");
  }
}

const describeIntegration =
  LETTA_API_KEY && isCloudBaseUrl(LETTA_BASE_URL) ? describe : describe.skip;

async function listModelHandlesWithRetry(
  client: Letta,
  maxAttempts = 3,
): Promise<string[]> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const models = await client.models.list();
      return models.map((m) => m.handle).filter((h): h is string => Boolean(h));
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  throw lastError;
}

describeIntegration("cloud models list", () => {
  test("includes letta/auto handle", async () => {
    const client = new Letta({
      baseURL: LETTA_BASE_URL,
      apiKey: LETTA_API_KEY,
    });

    const handles = await listModelHandlesWithRetry(client);
    expect(handles).toContain("letta/auto");
  });
});
