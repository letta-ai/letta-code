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
                ...(config.authHeader
                  ? { headers: { Authorization: `Bearer ${apiKey}` } }
                  : {}),
              },
              source: "local provider record",
            };
          }
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
