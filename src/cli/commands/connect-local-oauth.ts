import {
  getOAuthProvider,
  type OAuthPrompt,
} from "@earendil-works/pi-ai/oauth";
import {
  localOAuthAuthFromCredentials,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";
import type { ByokProvider } from "@/providers/byok-providers";
import { openOAuthBrowser } from "./connect-oauth-core";

export interface LocalOAuthConnectCallbacks {
  onStatus: (message: string) => void | Promise<void>;
  onPrompt?: (prompt: OAuthPrompt) => Promise<string>;
  openBrowser?: (authorizationUrl: string) => Promise<void>;
  signal?: AbortSignal;
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
    onSelect: async (prompt) => {
      if (prompt.options.length === 1) return prompt.options[0]?.id;
      throw new Error(
        `${oauthProvider.name} requires selection: ${prompt.message}`,
      );
    },
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
  });

  return { providerName: provider.providerName };
}
