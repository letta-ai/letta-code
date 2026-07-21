import {
  getOAuthProvider,
  type OAuthPrompt,
  type OAuthSelectPrompt,
} from "@earendil-works/pi-ai/oauth";
import {
  localOAuthAuthFromCredentials,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";
import type { LocalProviderTimeout } from "@/backend/local/local-provider-timeout";
import type { ByokProvider } from "@/providers/byok-providers";
import { openOAuthBrowser } from "./connect-oauth-core";

export interface LocalOAuthConnectCallbacks {
  onStatus: (message: string) => void | Promise<void>;
  onPrompt?: (prompt: OAuthPrompt) => Promise<string>;
  /** Answer a selection prompt (e.g. OpenAI Codex login method) with an option id. */
  onSelect?: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
  openBrowser?: (authorizationUrl: string) => Promise<void>;
  signal?: AbortSignal;
  baseURL?: string;
  timeout?: LocalProviderTimeout;
}

interface OAuthDeviceCodeInfo {
  verificationUri: string;
  userCode: string;
}

function localOAuthProviderId(provider: ByokProvider): string {
  const providerId = provider.oauthProviderId;
  if (!providerId) {
    throw new Error(`${provider.displayName} is missing an OAuth provider id.`);
  }
  return providerId;
}

async function defaultPrompt(
  providerName: string,
  prompt: OAuthPrompt,
): Promise<string> {
  if (prompt.allowEmpty) return "";
  throw new Error(`${providerName} requires input: ${prompt.message}`);
}

async function defaultSelect(
  prompt: OAuthSelectPrompt,
): Promise<string | undefined> {
  // pi-ai providers list their default option first (e.g. OpenAI Codex
  // browser login), so auto-select it when the caller has no selection UI.
  return prompt.options[0]?.id;
}

export async function runLocalOAuthConnectFlow(
  provider: ByokProvider,
  callbacks: LocalOAuthConnectCallbacks,
): Promise<{ providerName: string }> {
  const providerId = localOAuthProviderId(provider);
  const oauthProvider = getOAuthProvider(providerId);
  if (!oauthProvider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }

  const browserOpener = callbacks.openBrowser ?? openOAuthBrowser;
  await callbacks.onStatus(`Starting ${oauthProvider.name} login...`);

  const loginCallbacks = {
    signal: callbacks.signal,
    onAuth: (info) => {
      const status = [
        `Open this URL to authenticate ${oauthProvider.name}:`,
        "",
        info.url,
        ...(info.instructions ? ["", info.instructions] : []),
      ].join("\n");
      void Promise.resolve(callbacks.onStatus(status));
      void browserOpener(info.url);
    },
    onPrompt: (prompt) =>
      callbacks.onPrompt?.(prompt) ?? defaultPrompt(oauthProvider.name, prompt),
    onProgress: (message) => {
      void Promise.resolve(callbacks.onStatus(message));
    },
    onSelect: (prompt) => callbacks.onSelect?.(prompt) ?? defaultSelect(prompt),
  } as Parameters<typeof oauthProvider.login>[0] & {
    onDeviceCode?: (info: OAuthDeviceCodeInfo) => void;
  };

  loginCallbacks.onDeviceCode = (info) => {
    const status = [
      `Open this URL to authenticate ${oauthProvider.name}:`,
      "",
      info.verificationUri,
      "",
      `Enter code: ${info.userCode}`,
    ].join("\n");
    void Promise.resolve(callbacks.onStatus(status));
    void browserOpener(info.verificationUri);
  };

  const credentials = await oauthProvider.login(loginCallbacks);

  setLocalOAuthProvider({
    providerName: provider.providerName,
    providerType: provider.providerType,
    auth: localOAuthAuthFromCredentials(credentials),
    baseURL: callbacks.baseURL,
    timeout: callbacks.timeout,
  });

  return { providerName: provider.providerName };
}
