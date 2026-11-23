import type { AuthInteraction, OAuthAuth } from "@earendil-works/pi-ai";
import type {
  OAuthLoginCallbacks,
  OAuthPrompt,
  OAuthSelectPrompt,
} from "@earendil-works/pi-ai/oauth";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  getRegisteredPiProvider,
  type PiProviderOAuthConfig,
} from "./pi-provider-mod-registry";

let builtinOAuth: Map<string, OAuthAuth> | undefined;

function builtinOAuthAuths(): Map<string, OAuthAuth> {
  builtinOAuth ??= new Map(
    builtinProviders().flatMap((provider) =>
      provider.auth.oauth ? [[provider.id, provider.auth.oauth] as const] : [],
    ),
  );
  return builtinOAuth;
}

function legacyCallbacksFromInteraction(
  interaction: AuthInteraction,
): OAuthLoginCallbacks {
  return {
    ...(interaction.signal ? { signal: interaction.signal } : {}),
    onAuth: (info) =>
      interaction.notify({
        type: "auth_url",
        url: info.url,
        ...(info.instructions ? { instructions: info.instructions } : {}),
      }),
    onDeviceCode: (info) =>
      interaction.notify({ type: "device_code", ...info }),
    onProgress: (message) => interaction.notify({ type: "progress", message }),
    onPrompt: (prompt: OAuthPrompt) =>
      interaction.prompt({
        type: "text",
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
      }),
    onSelect: (prompt: OAuthSelectPrompt) =>
      interaction.prompt({
        type: "select",
        message: prompt.message,
        options: prompt.options.map((option) => ({
          id: option.id,
          label: option.label,
        })),
      }),
  };
}

export function modOAuthAuth(
  providerName: string,
  config: PiProviderOAuthConfig,
  registration?: { authHeader?: boolean },
): OAuthAuth {
  return {
    name: config.name ?? providerName,
    login: async (interaction) => ({
      type: "oauth",
      ...(await config.login(legacyCallbacksFromInteraction(interaction))),
    }),
    refresh: async (credential) => ({
      type: "oauth",
      ...(await config.refreshToken(credential)),
    }),
    toAuth: async (credential) => {
      const apiKey = config.getApiKey(credential);
      return {
        apiKey,
        ...(registration?.authHeader
          ? { headers: { Authorization: `Bearer ${apiKey}` } }
          : {}),
      };
    },
  };
}

export function getProviderOAuthAuth(
  providerId: string,
): OAuthAuth | undefined {
  const registered = getRegisteredPiProvider(providerId);
  if (registered?.config.oauth) {
    return modOAuthAuth(
      registered.providerName,
      registered.config.oauth,
      registered.config,
    );
  }
  return builtinOAuthAuths().get(providerId);
}

export function listBuiltinOAuthProviders(): Array<{
  id: string;
  name: string;
}> {
  return [...builtinOAuthAuths()].map(([id, oauth]) => ({
    id,
    name: oauth.name,
  }));
}
