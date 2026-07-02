import { describe, expect, mock, test } from "bun:test";
import {
  isChatGPTOAuthConnected,
  runChatGPTOAuthConnectFlow,
} from "@/cli/commands/connect-oauth-core";

describe("connect OAuth core", () => {
  test("runs full OAuth flow and creates provider", async () => {
    const startOAuth = mock(() =>
      Promise.resolve({
        authorizationUrl: "https://auth.openai.com/oauth/authorize?abc",
        state: "state-123",
        codeVerifier: "verifier-123",
        redirectUri: "http://localhost:1455/auth/callback",
      }),
    );
    const serverClose = mock(() => undefined);
    const startCallbackServer = mock(() =>
      Promise.resolve({
        result: { code: "oauth-code", state: "state-123" },
        server: { close: serverClose },
      }),
    );
    const exchangeTokens = mock(() =>
      Promise.resolve({
        access_token: "access-token",
        id_token: "id-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const extractAccountId = mock(() => "acct_123");
    const createOrUpdateProvider = mock(() =>
      Promise.resolve({ id: "provider-1" }),
    );
    const storeOAuthState = mock(() => undefined);
    const clearOAuthState = mock(() => undefined);
    const openBrowser = mock(() => Promise.resolve());
    const abortController = new AbortController();
    const statuses: string[] = [];

    const result = await runChatGPTOAuthConnectFlow(
      {
        onStatus: (status) => {
          statuses.push(status);
        },
        openBrowser,
        signal: abortController.signal,
      },
      {
        startOAuth,
        startCallbackServer,
        exchangeTokens,
        extractAccountId,
        createOrUpdateProvider,
        storeOAuthState,
        clearOAuthState,
      },
    );

    expect(result.providerName).toBe("chatgpt-plus-pro");
    expect(startOAuth).toHaveBeenCalledTimes(1);
    expect(startCallbackServer).toHaveBeenCalledTimes(1);
    expect(startCallbackServer).toHaveBeenCalledWith(
      "state-123",
      1455,
      abortController.signal,
    );
    expect(exchangeTokens).toHaveBeenCalledWith(
      "oauth-code",
      "verifier-123",
      "http://localhost:1455/auth/callback",
    );
    expect(extractAccountId).toHaveBeenCalledWith("access-token");
    expect(createOrUpdateProvider).toHaveBeenCalledTimes(1);
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: "access-token",
        id_token: "id-token",
        refresh_token: "refresh-token",
        account_id: "acct_123",
      }),
      "chatgpt-plus-pro",
    );
    expect(storeOAuthState).toHaveBeenCalledWith(
      "state-123",
      "verifier-123",
      "http://localhost:1455/auth/callback",
      "openai",
    );
    expect(clearOAuthState).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?abc",
    );
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(statuses.length).toBeGreaterThan(3);
  });

  test("uses custom ChatGPT OAuth provider name", async () => {
    const createOrUpdateProvider = mock(() =>
      Promise.resolve({ id: "provider-work" }),
    );

    const result = await runChatGPTOAuthConnectFlow(
      {
        providerName: "chatgpt-work",
        onStatus: () => undefined,
        openBrowser: () => Promise.resolve(),
      },
      {
        startOAuth: () =>
          Promise.resolve({
            authorizationUrl: "https://auth.openai.com/oauth/authorize?abc",
            state: "state-123",
            codeVerifier: "verifier-123",
            redirectUri: "http://localhost:1455/auth/callback",
          }),
        startCallbackServer: () =>
          Promise.resolve({
            result: { code: "oauth-code", state: "state-123" },
            server: { close: () => undefined },
          }),
        exchangeTokens: () =>
          Promise.resolve({
            access_token: "access-token",
            id_token: "id-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        extractAccountId: () => "acct_123",
        createOrUpdateProvider,
        storeOAuthState: () => undefined,
        clearOAuthState: () => undefined,
      },
    );

    expect(result.providerName).toBe("chatgpt-work");
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      expect.any(Object),
      "chatgpt-work",
    );
  });

  test("clears OAuth state when flow fails", async () => {
    const expectedError = new Error("token exchange failed");
    const clearOAuthState = mock(() => undefined);

    await expect(
      runChatGPTOAuthConnectFlow(
        {
          onStatus: () => undefined,
          openBrowser: () => Promise.resolve(),
        },
        {
          startOAuth: () =>
            Promise.resolve({
              authorizationUrl: "https://auth.openai.com/oauth/authorize?abc",
              state: "state-123",
              codeVerifier: "verifier-123",
              redirectUri: "http://localhost:1455/auth/callback",
            }),
          startCallbackServer: () =>
            Promise.resolve({
              result: { code: "oauth-code", state: "state-123" },
              server: { close: () => undefined },
            }),
          exchangeTokens: () => Promise.reject(expectedError),
          extractAccountId: () => "acct_123",
          createOrUpdateProvider: () => Promise.resolve({ id: "provider-1" }),
          storeOAuthState: () => undefined,
          clearOAuthState,
        },
      ),
    ).rejects.toThrow("token exchange failed");

    expect(clearOAuthState).toHaveBeenCalledTimes(1);
  });

  test("isChatGPTOAuthConnected reflects provider presence", async () => {
    expect(
      await isChatGPTOAuthConnected({
        getProvider: () => Promise.resolve(null),
      }),
    ).toBe(false);

    expect(
      await isChatGPTOAuthConnected({
        getProvider: () =>
          Promise.resolve({
            id: "provider-1",
            name: "chatgpt-plus-pro",
            provider_type: "chatgpt_oauth",
          }),
      }),
    ).toBe(true);
  });
});
