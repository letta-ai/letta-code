import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { revokeToken } from "@/auth/oauth";
import {
  buildLogoutMessage,
  buildLogoutRevokeFailedMessage,
  buildLogoutSuccessMessage,
  revokeAndClearCredentials,
} from "@/cli/helpers/logout-message";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("buildLogoutSuccessMessage", () => {
  test("uses the standard success message when no env API key is set", () => {
    expect(buildLogoutSuccessMessage(false)).toBe(
      "✓ Logged out successfully. Run 'letta' to re-authenticate.",
    );
  });

  test("warns when LETTA_API_KEY remains set in the environment", () => {
    const message = buildLogoutSuccessMessage(true);

    expect(message).toContain("✓ Cleared saved Letta credentials.");
    expect(message).toContain("LETTA_API_KEY is still set");
    expect(message).toContain("/logout does not clear environment variables");
    expect(message).not.toContain("Run 'letta' to re-authenticate.");
  });
});

describe("revokeAndClearCredentials", () => {
  test("a failed server revoke still clears local state and warns the user", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ detail: "Internal Server Error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const clearLocalCredentials = mock(async () => {});

    const { revokeFailed } = await revokeAndClearCredentials({
      refreshToken: "refresh-token",
      revokeToken,
      clearLocalCredentials,
    });

    expect(revokeFailed).toBe(true);
    expect(clearLocalCredentials).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "Warning: Failed to revoke token: HTTP 500",
    );

    const message = buildLogoutMessage({ hasEnvApiKey: false, revokeFailed });
    expect(message).toContain("server-side revoke failed");
    expect(message).toContain("Settings > Profile > Connected Applications");
    expect(message).not.toContain("Logged out successfully");
  });

  test("a successful server revoke clears local state without a warning", async () => {
    globalThis.fetch = mock(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const clearLocalCredentials = mock(async () => {});

    const { revokeFailed } = await revokeAndClearCredentials({
      refreshToken: "refresh-token",
      revokeToken,
      clearLocalCredentials,
    });

    expect(revokeFailed).toBe(false);
    expect(clearLocalCredentials).toHaveBeenCalledTimes(1);
  });

  test("skips the server revoke when there is no refresh token", async () => {
    const revoke = mock(async () => true);
    const clearLocalCredentials = mock(async () => {});

    const { revokeFailed } = await revokeAndClearCredentials({
      refreshToken: undefined,
      revokeToken: revoke,
      clearLocalCredentials,
    });

    expect(revokeFailed).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(clearLocalCredentials).toHaveBeenCalledTimes(1);
  });
});

describe("buildLogoutRevokeFailedMessage", () => {
  test("keeps the local agent and env API key notes", () => {
    const message = buildLogoutRevokeFailedMessage({
      hasEnvApiKey: true,
      localAgentLabel: "my-agent",
    });

    expect(message).toContain("server-side revoke failed");
    expect(message).toContain("You're still using your local agent my-agent.");
    expect(message).toContain("LETTA_API_KEY is still set");
  });
});

describe("buildLogoutMessage", () => {
  test("keeps the existing messages when the revoke succeeded", () => {
    expect(
      buildLogoutMessage({ hasEnvApiKey: false, revokeFailed: false }),
    ).toBe(buildLogoutSuccessMessage(false));
    expect(
      buildLogoutMessage({ hasEnvApiKey: true, revokeFailed: false }),
    ).toBe(buildLogoutSuccessMessage(true));
    expect(
      buildLogoutMessage({
        hasEnvApiKey: false,
        revokeFailed: false,
        localAgentLabel: "my-agent",
      }),
    ).toBe(
      "Logged out successfully. You're still using your local agent my-agent.",
    );
  });
});
