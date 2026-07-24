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

/**
 * pi-ai 0.81 removed the standalone OAuth registry: OAuth flows live on
 * `Provider.auth.oauth`. This module is the lookup seam for Letta's local
 * OAuth glue (login flows, token refresh in the auth store): built-in
 * providers expose their `OAuthAuth` directly, and mod-registered providers
 * get their legacy `PiProviderOAuthConfig` adapted onto the same interface.
 */

let builtinOAuth: Map<string, OAuthAuth> | undefined;

function builtinOAuthAuths(): Map<string, OAuthAuth> {
  builtinOAuth ??= new Map(
    builtinProviders().flatMap((provider) =>
      provider.auth.oauth ? [[provider.id, provider.auth.oauth] as const] : [],
    ),
  );
  return builtinOAuth;
}

/** Legacy extension-callback surface driven from a pi-ai AuthInteraction. */
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

/** Adapts a mod's declarative OAuth config onto pi-ai's OAuthAuth. */
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

/**
 * OAuth implementation for a provider id: mod registration first (matching
 * the resolution order everywhere else), then built-in pi-ai providers.
 */
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

/** Built-in providers that support subscription (OAuth) login. */
export function listBuiltinOAuthProviders(): Array<{
  id: string;
  name: string;
}> {
  return [...builtinOAuthAuths()].map(([id, oauth]) => ({
    id,
    name: oauth.name,
  }));
}
