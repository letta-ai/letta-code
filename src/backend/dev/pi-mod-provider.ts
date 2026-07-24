import type {
  Api,
  Model,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { knownApiStreams } from "./pi-api-streams";
import { modOAuthAuth } from "./pi-oauth";
import type {
  PiProviderModelRegistration,
  PiProviderRegistration,
  RegisteredPiProvider,
} from "./pi-provider-mod-registry";
import { resolveRegisteredPiProviderHeaders } from "./pi-provider-mod-registry";
import {
  getRegisteredPiProviderLocalRecord,
  listRegisteredPiProviderModels,
  resolveRegisteredPiProviderRuntimeConnection,
} from "./registered-pi-provider-runtime";

/**
 * Maps a mod's model registration to the complete pi-ai Model the provider
 * publishes. Connection-derived auth headers are intentionally not baked in:
 * they are per-request state resolved by pi-model-factory and passed as
 * stream options, which pi-ai merges over provider defaults.
 */
export function registrationModelToPiModel(input: {
  providerName: string;
  config: PiProviderRegistration;
  model: PiProviderModelRegistration;
  baseURL?: string;
  headers?: Record<string, string>;
}): Model<Api> {
  const api = input.model.api ?? input.config.api;
  if (!api) {
    throw new Error(
      `Provider "${input.providerName}" model "${input.model.id}" is missing an api`,
    );
  }
  const headers = {
    ...input.headers,
    ...input.model.headers,
  };
  return {
    id: input.model.id,
    name: input.model.name,
    api,
    provider: input.providerName,
    baseUrl: input.model.baseUrl ?? input.baseURL ?? "",
    reasoning: input.model.reasoning,
    ...(input.model.thinkingLevelMap
      ? { thinkingLevelMap: input.model.thinkingLevelMap }
      : {}),
    input: input.model.input,
    cost: input.model.cost,
    contextWindow: input.model.contextWindow,
    maxTokens: input.model.maxTokens,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(input.model.compat ? { compat: input.model.compat } : {}),
  } as Model<Api>;
}

export interface ModPiProviderOptions {
  registered: RegisteredPiProvider;
  storageDir?: string;
}

/**
 * Real pi-ai Provider for a mod-registered provider (LET-10130). The
 * declarative mod registration stays the mod-facing vocabulary; this adapter
 * turns it into the concrete runtime unit: statically declared models are
 * published as complete pi-ai Models, a mod `listModels` hook becomes the
 * provider's dynamic `refreshModels` (with last-known retention on failure,
 * seeded from the static declaration), and stream dispatch runs through the
 * provider's per-API implementations.
 */
export function createModPiProvider(options: ModPiProviderOptions): Provider {
  const { registered, storageDir } = options;
  const config = registered.config;
  const providerName = registered.providerName;
  const connection = resolveRegisteredPiProviderRuntimeConnection(
    registered,
    storageDir,
  );
  const baseURL = connection.baseURL ?? config.baseUrl;
  const declaredHeaders = resolveRegisteredPiProviderHeaders(config.headers);

  const toModel = (model: PiProviderModelRegistration): Model<Api> =>
    registrationModelToPiModel({
      providerName,
      config,
      model,
      ...(baseURL ? { baseURL } : {}),
      ...(declaredHeaders ? { headers: declaredHeaders } : {}),
    });

  const staticModels = (config.models ?? []).map(toModel);

  // Only providers with a listModels hook are dynamic; static registrations
  // publish their declared models and never refresh. Refresh auth comes
  // solely from the RefreshModelsContext credential the Models runtime
  // resolved (OAuth already refreshed under the store lock) — no parallel
  // auth read here.
  const fetchModels = config.listModels
    ? async (context: RefreshModelsContext): Promise<readonly Model<Api>[]> => {
        const record = getRegisteredPiProviderLocalRecord(
          registered,
          storageDir,
        );
        const apiKey =
          context.credential?.type === "oauth"
            ? config.oauth?.getApiKey(context.credential)
            : context.credential?.key;
        const listed = await listRegisteredPiProviderModels(registered, {
          apiKey,
          baseUrl: record?.base_url ?? config.baseUrl,
          headers: declaredHeaders,
        });
        return listed.map(toModel);
      }
    : undefined;

  return createProvider<Api>({
    id: providerName,
    name: config.name ?? providerName,
    ...(baseURL ? { baseUrl: baseURL } : {}),
    ...(declaredHeaders ? { headers: declaredHeaders } : {}),
    auth: {
      apiKey: {
        name: `${config.name ?? providerName} API key`,
        resolve: async ({ credential }) => {
          const apiKey =
            credential?.key ??
            resolveRegisteredPiProviderRuntimeConnection(registered, storageDir)
              .apiKey;
          if (apiKey) {
            return {
              auth: {
                apiKey,
                // authHeader mods carry their key as an explicit header;
                // this is provider-owned auth, not factory-side shaping.
                ...(config.authHeader
                  ? { headers: { Authorization: `Bearer ${apiKey}` } }
                  : {}),
              },
              source: "local provider record",
            };
          }
          // connect:false mods are explicitly keyless — report configured so
          // the Models runtime refreshes them (mirrors
          // isRegisteredPiProviderConfigured).
          return config.connect === false ? { auth: {} } : undefined;
        },
      },
      ...(config.oauth
        ? { oauth: modOAuthAuth(providerName, config.oauth, config) }
        : {}),
    },
    models: staticModels,
    ...(fetchModels ? { fetchModels } : {}),
    api: knownApiStreams(),
  });
}
