import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type { LocalProviderRecord } from "@/backend/local/local-provider-auth-store";
import { getPiProviderSpec } from "./pi-provider-registry";

export type OAuthAliasProviderType = "chatgpt_oauth" | "anthropic";
export type OAuthAliasCanonicalProvider = "openai-codex" | "anthropic";

export interface OAuthAliasDefinition {
  providerId: string;
  canonicalProvider: OAuthAliasCanonicalProvider;
  providerType: OAuthAliasProviderType;
  baseUrl?: string;
}

const CANONICAL_PROVIDER_BY_TYPE: Readonly<
  Record<OAuthAliasProviderType, OAuthAliasCanonicalProvider>
> = {
  chatgpt_oauth: "openai-codex",
  anthropic: "anthropic",
};

/** Returns alias metadata only for custom named OAuth records we can clone. */
export function oauthAliasDefinitionFromRecord(
  record: LocalProviderRecord,
): OAuthAliasDefinition | undefined {
  if (
    record.auth.type !== "oauth" ||
    !Object.hasOwn(CANONICAL_PROVIDER_BY_TYPE, record.provider_type)
  ) {
    return undefined;
  }

  const providerType = record.provider_type as OAuthAliasProviderType;
  const canonicalProvider = CANONICAL_PROVIDER_BY_TYPE[providerType];
  if (
    getPiProviderSpec(canonicalProvider).localProviderNames.includes(
      record.name,
    )
  ) {
    return undefined;
  }

  return {
    providerId: record.name,
    canonicalProvider,
    providerType,
    ...(record.base_url ? { baseUrl: record.base_url } : {}),
  };
}

/**
 * Clones a canonical OAuth provider as a first-class provider id. Models keep
 * their canonical API implementation but are addressed and authenticated by
 * the alias. No alias-specific request header is added.
 */
export function createOAuthAliasProvider(
  alias: OAuthAliasDefinition,
  canonical: Provider,
): Provider {
  if (canonical.id !== alias.canonicalProvider || !canonical.auth.oauth) {
    throw new Error(
      `Cannot create OAuth alias "${alias.providerId}" from provider "${canonical.id}"`,
    );
  }

  const models = canonical.getModels().map((model) => ({
    ...model,
    provider: alias.providerId,
    ...(alias.baseUrl ? { baseUrl: alias.baseUrl } : {}),
  })) as readonly Model<Api>[];

  return {
    id: alias.providerId,
    name: alias.providerId,
    ...((alias.baseUrl ?? canonical.baseUrl)
      ? { baseUrl: alias.baseUrl ?? canonical.baseUrl }
      : {}),
    ...(canonical.headers ? { headers: canonical.headers } : {}),
    auth: { oauth: canonical.auth.oauth },
    getModels: () => models,
    stream: (model, context, options) =>
      canonical.stream(model, context, options),
    streamSimple: (model, context, options) =>
      canonical.streamSimple(model, context, options),
  };
}
