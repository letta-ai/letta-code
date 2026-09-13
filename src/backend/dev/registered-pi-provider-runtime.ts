import {
  getLocalProviderRecordByName,
  type LocalProviderRecord,
  localProviderApiKeyFromRecord,
} from "@/backend/local/local-provider-auth-store";
import {
  type LocalProviderTimeout,
  resolveLocalProviderTimeout,
} from "@/backend/local/local-provider-timeout";
import {
  resolveRegisteredPiProviderApiKey,
  resolveRegisteredPiProviderHeaders,
} from "./pi-provider-mod-registry";
import type {
  PiProviderModelRegistration,
  RegisteredPiProvider,
} from "./pi-provider-mod-types";
import { getPiProviderSpec, isPiProvider } from "./pi-provider-registry";

export interface RegisteredPiProviderRuntimeConnection {
  apiKey?: string;
  baseURL?: string;
  timeout: LocalProviderTimeout;
  headers?: Record<string, string>;
  record?: LocalProviderRecord;
}

interface RegisteredPiProviderModelListConnection {
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string;
  headers?: Record<string, string>;
}

export function getRegisteredPiProviderLocalNames(
  provider: RegisteredPiProvider,
): readonly string[] {
  return isPiProvider(provider.providerName)
    ? getPiProviderSpec(provider.providerName).localProviderNames
    : [provider.providerName];
}

export function findRegisteredPiProviderLocalRecord(
  provider: RegisteredPiProvider,
  records: readonly LocalProviderRecord[],
): LocalProviderRecord | undefined {
  const providerNames = getRegisteredPiProviderLocalNames(provider);
  return records.find((record) => providerNames.includes(record.name));
}

export function getRegisteredPiProviderLocalRecord(
  provider: RegisteredPiProvider,
  storageDir?: string,
): LocalProviderRecord | null {
  for (const providerName of getRegisteredPiProviderLocalNames(provider)) {
    const record = getLocalProviderRecordByName(providerName, storageDir);
    if (record) return record;
  }
  return null;
}

export function isRegisteredPiProviderConfigured(
  provider: RegisteredPiProvider,
  records: readonly LocalProviderRecord[],
): boolean {
  return Boolean(
    findRegisteredPiProviderLocalRecord(provider, records) ||
      (provider.config.apiKey
        ? process.env[provider.config.apiKey]
        : undefined) ||
      provider.config.connect === false,
  );
}

export function resolveRegisteredPiProviderRuntimeConnection(
  provider: RegisteredPiProvider,
  storageDir?: string,
): RegisteredPiProviderRuntimeConnection {
  const providerNames = getRegisteredPiProviderLocalNames(provider);
  const record = getRegisteredPiProviderLocalRecord(provider, storageDir);
  return {
    apiKey:
      localProviderApiKeyFromRecord(record) ??
      resolveRegisteredPiProviderApiKey(provider.config.apiKey),
    baseURL: record?.base_url ?? provider.config.baseUrl,
    timeout: resolveLocalProviderTimeout({
      configuredTimeout: record?.timeout,
      providerIds: providerNames,
    }),
    headers: resolveRegisteredPiProviderHeaders(provider.config.headers),
    ...(record ? { record } : {}),
  };
}

export async function listRegisteredPiProviderModels(
  provider: RegisteredPiProvider,
  connection: RegisteredPiProviderModelListConnection,
): Promise<PiProviderModelRegistration[]> {
  const listed = await provider.config.listModels?.({
    id: provider.providerName,
    providerName: provider.providerName,
    baseUrl: connection.baseUrl ?? connection.baseURL,
    apiKey: connection.apiKey,
    headers: connection.headers,
  });
  return listed ?? provider.config.models ?? [];
}
