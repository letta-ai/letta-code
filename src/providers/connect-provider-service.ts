import type { ProviderResponse } from "@/backend/api/providers";
import type { LocalProviderTimeout } from "@/backend/local/local-provider-timeout";
import {
  type AuthMethod,
  type ByokProvider,
  checkProviderApiKey,
  createOrUpdateProvider,
  defaultProviderApiKey,
  getConnectedProviders,
  getProviderConfigs,
  type ProviderConnectionOptions,
  type ProviderField,
  type ProviderStorageTarget,
  removeProviderByName,
} from "@/providers/byok-providers";
import {
  connectedRecordsForProvider,
  uniqueProviderNames,
} from "@/providers/provider-connections";

export interface ConnectProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
}

export interface ConnectProviderAuthMethod {
  id: string;
  label: string;
  description: string;
  fields: ConnectProviderField[];
}

export interface ConnectProviderConnectionState {
  is_connected: boolean;
  id?: string;
  provider_name?: string;
  provider_type?: string;
  auth_type?: "api" | "oauth";
  base_url?: string;
  timeout?: LocalProviderTimeout;
  region?: string;
}

export interface ConnectProviderEntry {
  id: string;
  display_name: string;
  description: string;
  provider_type: string;
  provider_name: string;
  provider_names: string[];
  is_oauth?: boolean;
  oauth_provider_id?: string;
  requires_api_key: boolean;
  fields?: ConnectProviderField[];
  auth_methods?: ConnectProviderAuthMethod[];
  connected: ConnectProviderConnectionState;
  connected_providers: ConnectProviderConnectionState[];
}

export interface ListConnectProvidersResult<
  TTarget extends ProviderStorageTarget = ProviderStorageTarget,
> {
  target: TTarget;
  providers: ConnectProviderEntry[];
}

export interface ConnectProviderInput<
  TTarget extends ProviderStorageTarget = ProviderStorageTarget,
> {
  target: TTarget;
  providerId: string;
  authMethodId?: string;
  fields: Record<string, string>;
}

export interface DisconnectProviderInput<
  TTarget extends ProviderStorageTarget = ProviderStorageTarget,
> {
  target: TTarget;
  providerId: string;
  providerName?: string;
}

export interface ResolvedProviderConnectionFields {
  apiKey: string;
  accessKey?: string;
  region?: string;
  profile?: string;
  options: ProviderConnectionOptions;
}

function serializeConnectedProvider(
  record: ProviderResponse | undefined,
): ConnectProviderConnectionState {
  if (!record) return { is_connected: false };
  return {
    is_connected: true,
    id: record.id,
    provider_name: record.name,
    provider_type: record.provider_type,
    ...(record.auth_type ? { auth_type: record.auth_type } : {}),
    ...(record.base_url ? { base_url: record.base_url } : {}),
    ...(record.timeout !== undefined ? { timeout: record.timeout } : {}),
    ...(record.region ? { region: record.region } : {}),
  };
}

function serializeFields(
  fields: readonly ProviderField[],
): ConnectProviderField[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.secret !== undefined ? { secret: field.secret } : {}),
  }));
}

function defaultApiKeyFields(provider: ByokProvider): ConnectProviderField[] {
  return [
    {
      key: "apiKey",
      label: "API Key",
      secret: true,
      required: provider.requiresApiKey !== false,
    },
  ];
}

function serializeAuthMethods(
  authMethods: readonly AuthMethod[],
): ConnectProviderAuthMethod[] {
  return authMethods.map((method) => ({
    id: method.id,
    label: method.label,
    description: method.description,
    fields: serializeFields(method.fields),
  }));
}

function fieldsForProvider(
  provider: ByokProvider,
): ConnectProviderField[] | undefined {
  if (provider.isOAuth || provider.authMethods) return undefined;
  if (provider.fields) return serializeFields(provider.fields);
  return defaultApiKeyFields(provider);
}

function requiredFieldsForProvider(
  provider: ByokProvider,
  authMethodId: string | undefined,
): readonly ProviderField[] {
  if (provider.isOAuth) {
    throw new Error(
      `${provider.displayName} uses OAuth. Use the OAuth connection flow instead.`,
    );
  }

  if (provider.authMethods) {
    if (!authMethodId) {
      throw new Error(`Select an auth method for ${provider.displayName}.`);
    }
    const authMethod = provider.authMethods.find(
      (method) => method.id === authMethodId,
    );
    if (!authMethod) {
      throw new Error(
        `Unknown auth method "${authMethodId}" for ${provider.displayName}.`,
      );
    }
    return authMethod.fields;
  }

  if (authMethodId) {
    throw new Error(`${provider.displayName} does not use auth methods.`);
  }

  if (provider.fields) return provider.fields;
  if (provider.requiresApiKey === false) return [];
  return [{ key: "apiKey", label: "API Key", secret: true }];
}

function fieldValue(
  fields: Record<string, string>,
  key: string,
): string | undefined {
  const value = fields[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function resolveProviderConnectionFields(
  provider: ByokProvider,
  input: { authMethodId?: string; fields: Record<string, string> },
): ResolvedProviderConnectionFields {
  const requiredFields = requiredFieldsForProvider(
    provider,
    input.authMethodId,
  );
  const missingField = requiredFields.find(
    (field) => !fieldValue(input.fields, field.key),
  );
  if (missingField) {
    throw new Error(`Missing ${missingField.label}.`);
  }

  const apiKey =
    fieldValue(input.fields, "apiKey") ?? defaultProviderApiKey(provider);
  const apiKeyRequired = requiredFields.some((field) => field.key === "apiKey");
  if (!apiKey && apiKeyRequired) {
    throw new Error(`Missing ${provider.displayName} API key.`);
  }

  const accessKey = fieldValue(input.fields, "accessKey");
  const region = fieldValue(input.fields, "region");
  const profile = fieldValue(input.fields, "profile");
  const baseURL = fieldValue(input.fields, "baseUrl");

  return {
    apiKey: apiKey ?? "",
    ...(accessKey ? { accessKey } : {}),
    ...(region ? { region } : {}),
    ...(profile ? { profile } : {}),
    options: {
      ...(baseURL ? { baseURL } : {}),
    },
  };
}

function resolveProvider(
  providers: readonly ByokProvider[],
  providerId: string,
): ByokProvider {
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return provider;
}

export function buildConnectProviderEntries(
  providers: readonly ByokProvider[],
  connectedProviders: ReadonlyMap<string, ProviderResponse>,
  target: ProviderStorageTarget,
): ConnectProviderEntry[] {
  return providers.map((provider) => {
    const connectedRecords = connectedRecordsForProvider(
      provider,
      connectedProviders,
      target,
    );
    const connected = connectedRecords[0];
    const fields = fieldsForProvider(provider);
    return {
      id: provider.id,
      display_name: provider.displayName,
      description: provider.description,
      provider_type: provider.providerType,
      provider_name: provider.providerName,
      provider_names: uniqueProviderNames(provider),
      ...(provider.isOAuth ? { is_oauth: true } : {}),
      ...(provider.oauthProviderId
        ? { oauth_provider_id: provider.oauthProviderId }
        : {}),
      requires_api_key: provider.requiresApiKey !== false,
      ...(fields ? { fields } : {}),
      ...(provider.authMethods
        ? { auth_methods: serializeAuthMethods(provider.authMethods) }
        : {}),
      connected: serializeConnectedProvider(connected),
      connected_providers: connectedRecords.map(serializeConnectedProvider),
    };
  });
}

export async function listConnectProviders<
  TTarget extends ProviderStorageTarget,
>(target: TTarget): Promise<ListConnectProvidersResult<TTarget>> {
  const [providers, connectedProviders] = await Promise.all([
    Promise.resolve(getProviderConfigs(target)),
    getConnectedProviders({ target }),
  ]);
  return {
    target,
    providers: buildConnectProviderEntries(
      providers,
      connectedProviders,
      target,
    ),
  };
}

export async function connectProvider<TTarget extends ProviderStorageTarget>(
  input: ConnectProviderInput<TTarget>,
): Promise<ListConnectProvidersResult<TTarget>> {
  const provider = resolveProvider(
    getProviderConfigs(input.target),
    input.providerId,
  );
  const resolved = resolveProviderConnectionFields(provider, {
    authMethodId: input.authMethodId,
    fields: input.fields,
  });

  await checkProviderApiKey(
    provider.providerType,
    resolved.apiKey,
    resolved.accessKey,
    resolved.region,
    resolved.profile,
    { target: input.target },
  );
  await createOrUpdateProvider(
    provider.providerType,
    provider.providerName,
    resolved.apiKey,
    resolved.accessKey,
    resolved.region,
    resolved.profile,
    resolved.options,
    { target: input.target },
  );

  return listConnectProviders(input.target);
}

export async function disconnectProvider<TTarget extends ProviderStorageTarget>(
  input: DisconnectProviderInput<TTarget>,
): Promise<ListConnectProvidersResult<TTarget>> {
  const providers = getProviderConfigs(input.target);
  const provider = resolveProvider(providers, input.providerId);
  const connectedProviders = await getConnectedProviders({
    target: input.target,
  });
  const connectedRecords = connectedRecordsForProvider(
    provider,
    connectedProviders,
    input.target,
  );
  const connected = input.providerName
    ? connectedRecords.find((record) => record.name === input.providerName)
    : connectedRecords[0];
  if (connected) {
    await removeProviderByName(connected.name, { target: input.target });
  }

  return listConnectProviders(input.target);
}
