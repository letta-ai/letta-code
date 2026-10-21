import type {
  AuthPrompt,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import type {
  OAuthCredentials,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai/oauth";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { getProviderOAuthAuth } from "@/backend/dev/pi-oauth";
import {
  localOAuthAuthFromCredentials,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";
import type { LocalProviderTimeout } from "@/backend/local/local-provider-timeout";
import {
  type ByokProvider,
  checkProviderApiKey,
  createOrUpdateProvider,
} from "@/providers/byok-providers";
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

function localOAuthProviderId(provider: ByokProvider): string {
  const providerId = provider.oauthProviderId;
  if (!providerId) {
    throw new Error(`${provider.displayName} is missing an OAuth provider id.`);
  }
  return providerId;
}

async function defaultSelect(prompt: AuthPrompt): Promise<string> {
  // pi-ai providers list their default option first (e.g. OpenAI Codex
  // browser login), so auto-select it when the caller has no selection UI.
  if (prompt.type !== "select") return "";
  return prompt.options[0]?.id ?? "";
}

/**
 * A prompt raced against an out-of-band resolution (e.g. an OAuth callback
 * server racing a manual-code prompt): with no UI to answer it, wait until
 * pi-ai cancels the prompt because the other path won.
 */
function waitForPromptCancellation(prompt: AuthPrompt): Promise<string> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (prompt.signal?.aborted) {
      abort();
      return;
    }
    prompt.signal?.addEventListener("abort", abort, { once: true });
  });
}

export interface ProviderOAuthLoginResult {
  providerName: string;
  credential: OAuthCredentials;
  apiKey: string;
}

export async function runProviderOAuthLogin(
  provider: ByokProvider,
  callbacks: LocalOAuthConnectCallbacks,
): Promise<ProviderOAuthLoginResult> {
  const providerId = localOAuthProviderId(provider);
  const oauth = getProviderOAuthAuth(providerId);
  if (!oauth) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }

  const browserOpener = callbacks.openBrowser ?? openOAuthBrowser;
  await callbacks.onStatus(`Starting ${oauth.name} login...`);

  // pi-ai 0.84+: ProviderAuthInteraction requires a concrete AbortSignal.
  const signal = callbacks.signal ?? new AbortController().signal;
  const interaction: ProviderAuthInteraction = {
    signal,
    notify: (event) => {
      switch (event.type) {
        case "auth_url": {
          const status = [
            `Open this URL to authenticate ${oauth.name}:`,
            "",
            event.url,
            ...(event.instructions ? ["", event.instructions] : []),
          ].join("\n");
          void Promise.resolve(callbacks.onStatus(status));
          void browserOpener(event.url);
          return;
        }
        case "device_code": {
          const status = [
            `Open this URL to authenticate ${oauth.name}:`,
            "",
            event.verificationUri,
            "",
            `Enter code: ${event.userCode}`,
          ].join("\n");
          void Promise.resolve(callbacks.onStatus(status));
          void browserOpener(event.verificationUri);
          return;
        }
        default:
          void Promise.resolve(callbacks.onStatus(event.message));
      }
    },
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        const answer = await callbacks.onSelect?.({
          message: prompt.message,
          options: prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
          })),
        });
        return answer ?? defaultSelect(prompt);
      }
      if (callbacks.onPrompt) {
        return callbacks.onPrompt({
          message: prompt.message,
          ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
        });
      }
      if (prompt.type === "manual_code" && prompt.signal) {
        return waitForPromptCancellation(prompt);
      }
      throw new Error(`${oauth.name} requires input: ${prompt.message}`);
    },
  };

  const credential = await oauth.login(interaction);
  if (credential.type !== "oauth") {
    throw new Error(`${oauth.name} returned invalid OAuth credentials.`);
  }
  const modelAuth = await oauth.toAuth(credential);
  if (!modelAuth.apiKey) {
    throw new Error(`${oauth.name} returned no API key.`);
  }

  return {
    providerName: provider.providerName,
    credential,
    apiKey: modelAuth.apiKey,
  };
}

export async function runCloudOAuthConnectFlow(
  provider: ByokProvider,
  callbacks: LocalOAuthConnectCallbacks,
): Promise<{ providerName: string }> {
  const result = await runProviderOAuthLogin(provider, callbacks);
  await callbacks.onStatus(`Validating ${provider.displayName} connection...`);
  await checkProviderApiKey(
    provider.providerType,
    result.apiKey,
    undefined,
    undefined,
    undefined,
    {
      target: "api",
    },
  );
  await callbacks.onStatus(`Saving ${provider.displayName} provider...`);
  await createOrUpdateProvider(
    provider.providerType,
    provider.providerName,
    result.apiKey,
    undefined,
    undefined,
    undefined,
    {},
    { target: "api" },
  );
  clearAvailableModelsCache();
  return { providerName: result.providerName };
}

export async function runLocalOAuthConnectFlow(
  provider: ByokProvider,
  callbacks: LocalOAuthConnectCallbacks,
): Promise<{ providerName: string }> {
  const result = await runProviderOAuthLogin(provider, callbacks);
  setLocalOAuthProvider({
    providerName: provider.providerName,
    providerType: provider.providerType,
    auth: localOAuthAuthFromCredentials(result.credential),
    baseURL: callbacks.baseURL,
    timeout: callbacks.timeout,
  });
  clearAvailableModelsCache();

  return { providerName: result.providerName };
}
