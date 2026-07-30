import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type {
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai/oauth";
import { getProviderOAuthAuth } from "@/backend/dev/pi-oauth";
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

export async function runLocalOAuthConnectFlow(
  provider: ByokProvider,
  callbacks: LocalOAuthConnectCallbacks,
): Promise<{ providerName: string }> {
  const providerId = localOAuthProviderId(provider);
  const oauth = getProviderOAuthAuth(providerId);
  if (!oauth) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }

  const browserOpener = callbacks.openBrowser ?? openOAuthBrowser;
  await callbacks.onStatus(`Starting ${oauth.name} login...`);

  const interaction: AuthInteraction = {
    ...(callbacks.signal ? { signal: callbacks.signal } : {}),
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

  setLocalOAuthProvider({
    providerName: provider.providerName,
    providerType: provider.providerType,
    auth: localOAuthAuthFromCredentials(credential),
    baseURL: callbacks.baseURL,
    timeout: callbacks.timeout,
  });

  return { providerName: provider.providerName };
}
