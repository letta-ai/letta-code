import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { listSharedAgentsForCurrentUser } from "@/cli/helpers/shared-agent-listing";
import { settingsManager } from "@/settings-manager";

const originalFetch = globalThis.fetch;
const originalGetSettingsWithSecureTokens =
  settingsManager.getSettingsWithSecureTokens;

beforeEach(() => {
  settingsManager.getSettingsWithSecureTokens = mock(async () => ({
    env: {
      LETTA_BASE_URL: "https://example.test",
      LETTA_API_KEY: "test-key",
    },
  })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  settingsManager.getSettingsWithSecureTokens =
    originalGetSettingsWithSecureTokens;
});

test("shared agent discovery carries the current sender", async () => {
  const actingUserIds: Array<string | null> = [];
  globalThis.fetch = mock(async (_input, init) => {
    actingUserIds.push(
      new Headers(init?.headers).get("X-Letta-Acting-User-Id"),
    );
    return new Response(JSON.stringify({ agents: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await listSharedAgentsForCurrentUser({}, "user-sender");

  expect(actingUserIds).toEqual(["user-sender"]);
});
