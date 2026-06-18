import {
  exchangeCodeForTokens,
  extractAccountIdFromToken,
  OPENAI_OAUTH_CONFIG,
  type OpenAITokens,
  startLocalOAuthServer,
  startOpenAIOAuth,
} from "@/auth/openai-oauth";
import {
  type ChatGPTOAuthConfig,
  createOrUpdateOpenAICodexProvider,
  getOpenAICodexProvider,
  normalizeChatGPTOAuthProviderName,
} from "@/providers/openai-codex-provider";
import { settingsManager } from "@/settings-manager";

interface OAuthCodeServerResult {
  result: {
    code: string;
    state: string;
  };
  server: {
    close: () => void;
  };
}

interface OAuthStartResult {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

interface OAuthFlowDeps {
  startOAuth: (port?: number) => Promise<OAuthStartResult>;
  startCallbackServer: (
    expectedState: string,
    port?: number,
    signal?: AbortSignal,
  ) => Promise<OAuthCodeServerResult>;
  exchangeTokens: (
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ) => Promise<OpenAITokens>;
  extractAccountId: (accessToken: string) => string;
  createOrUpdateProvider: (
    config: ChatGPTOAuthConfig,
    providerName: string,
  ) => Promise<unknown>;
  getProvider: () => Promise<unknown>;
  storeOAuthState: typeof settingsManager.storeOAuthState;
  clearOAuthState: typeof settingsManager.clearOAuthState;
}

const DEFAULT_DEPS: OAuthFlowDeps = {
  startOAuth: (port?: number) =>
    startOpenAIOAuth(
      (port as typeof OPENAI_OAUTH_CONFIG.defaultPort | undefined) ??
        OPENAI_OAUTH_CONFIG.defaultPort,
    ),
  startCallbackServer: (
    expectedState: string,
    port?: number,
    signal?: AbortSignal,
  ) =>
    startLocalOAuthServer(
      expectedState,
      (port as typeof OPENAI_OAUTH_CONFIG.defaultPort | undefined) ??
        OPENAI_OAUTH_CONFIG.defaultPort,
      signal,
    ),
  exchangeTokens: exchangeCodeForTokens,
  extractAccountId: extractAccountIdFromToken,
  createOrUpdateProvider: (config, providerName) =>
    createOrUpdateOpenAICodexProvider(config, {}, providerName),
  getProvider: getOpenAICodexProvider,
  storeOAuthState: (...args) => settingsManager.storeOAuthState(...args),
  clearOAuthState: () => settingsManager.clearOAuthState(),
};

export interface ChatGPTOAuthFlowCallbacks {
  onStatus: (message: string) => void | Promise<void>;
  openBrowser?: (authorizationUrl: string) => Promise<void>;
  signal?: AbortSignal;
  providerName?: string;
}

export async function openOAuthBrowser(
  authorizationUrl: string,
): Promise<void> {
  try {
    const { default: open } = await import("open");
    const subprocess = await open(authorizationUrl, { wait: false });
    subprocess.on("error", () => {
      // Ignore browser launch errors. The user can still open the URL manually.
    });
  } catch {
    // Ignore browser launch failures. The user can still open the URL manually.
  }
}

export async function isChatGPTOAuthConnected(
  deps: Partial<OAuthFlowDeps> = {},
): Promise<boolean> {
  const mergedDeps = { ...DEFAULT_DEPS, ...deps };
  const existing = await mergedDeps.getProvider();
  return Boolean(existing);
}

export async function runChatGPTOAuthConnectFlow(
  callbacks: ChatGPTOAuthFlowCallbacks,
  deps: Partial<OAuthFlowDeps> = {},
): Promise<{ providerName: string }> {
  const mergedDeps = { ...DEFAULT_DEPS, ...deps };
  const browserOpener = callbacks.openBrowser ?? openOAuthBrowser;
  const providerName = normalizeChatGPTOAuthProviderName(
    callbacks.providerName,
  );

  await callbacks.onStatus("Checking account eligibility...");

  try {
    await callbacks.onStatus(
      "Starting OAuth flow...\nA browser window will open for authorization.",
    );

    const { authorizationUrl, state, codeVerifier, redirectUri } =
      await mergedDeps.startOAuth(OPENAI_OAUTH_CONFIG.defaultPort);

    mergedDeps.storeOAuthState(state, codeVerifier, redirectUri, "openai");

    await callbacks.onStatus(
      `Starting local OAuth server on port ${OPENAI_OAUTH_CONFIG.defaultPort}...\n\n` +
        "Opening browser for authorization...\n" +
        "If the browser doesn't open automatically, visit:\n\n" +
        `${authorizationUrl}`,
    );

    const serverPromise = mergedDeps.startCallbackServer(
      state,
      OPENAI_OAUTH_CONFIG.defaultPort,
      callbacks.signal,
    );

    await browserOpener(authorizationUrl);

    await callbacks.onStatus(
      "Waiting for authorization...\n\n" +
        "Please complete the sign-in process in your browser.\n" +
        "The page will redirect automatically when done.\n\n" +
        "Press Esc to cancel.\n\n" +
        `If needed, visit:\n${authorizationUrl}`,
    );

    const { result, server } = await serverPromise;
    server.close();

    await callbacks.onStatus(
      "Authorization received! Exchanging code for tokens...",
    );
    const tokens = await mergedDeps.exchangeTokens(
      result.code,
      codeVerifier,
      redirectUri,
    );

    await callbacks.onStatus("Extracting account information...");
    const accountId = mergedDeps.extractAccountId(tokens.access_token);

    await callbacks.onStatus(
      `Creating ChatGPT OAuth provider '${providerName}'...`,
    );
    await mergedDeps.createOrUpdateProvider(
      {
        access_token: tokens.access_token,
        id_token: tokens.id_token,
        refresh_token: tokens.refresh_token,
        account_id: accountId,
        expires_at: Date.now() + tokens.expires_in * 1000,
      },
      providerName,
    );

    mergedDeps.clearOAuthState();
    return { providerName };
  } catch (error) {
    mergedDeps.clearOAuthState();
    throw error;
  }
}
