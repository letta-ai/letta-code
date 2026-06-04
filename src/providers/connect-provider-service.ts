import type { ProviderResponse } from "@/backend/api/providers";
import type { LocalProviderTimeout } from "@/backend/local/local-provider-timeout";
import {
  type AuthMethod,
  type ByokProvider,
  getConnectedProviders,
  getProviderConfigs,
  type ProviderField,
  type ProviderStorageTarget,
} from "@/providers/byok-providers";

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
}

export interface ListConnectProvidersResult<
  TTarget extends ProviderStorageTarget = ProviderStorageTarget,
> {
  target: TTarget;
  providers: ConnectProviderEntry[];
}

function uniqueProviderNames(provider: ByokProvider): string[] {
  return [
    ...new Set([provider.providerName, ...(provider.providerNames ?? [])]),
  ];
}

function providerIsConnectedToRecord(
  provider: ByokProvider,
  record: ProviderResponse | undefined,
  target: ProviderStorageTarget,
): record is ProviderResponse {
  if (!record) return false;
  if (target !== "local" || !record.auth_type) return true;
  return provider.isOAuth === true
    ? record.auth_type === "oauth"
    : record.auth_type !== "oauth";
}

function connectedRecordForProvider(
  provider: ByokProvider,
  connectedProviders: ReadonlyMap<string, ProviderResponse>,
  target: ProviderStorageTarget,
): ProviderResponse | undefined {
  for (const providerName of uniqueProviderNames(provider)) {
    const record = connectedProviders.get(providerName);
    if (providerIsConnectedToRecord(provider, record, target)) {
      return record;
    }
  }
  return undefined;
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

export function buildConnectProviderEntries(
  providers: readonly ByokProvider[],
  connectedProviders: ReadonlyMap<string, ProviderResponse>,
  target: ProviderStorageTarget,
): ConnectProviderEntry[] {
  return providers.map((provider) => {
    const connected = connectedRecordForProvider(
      provider,
      connectedProviders,
      target,
    );
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
