import type { ProviderResponse } from "@/backend/api/providers";
import type {
  ByokProvider,
  ProviderStorageTarget,
} from "@/providers/byok-providers";

export function uniqueProviderNames(provider: ByokProvider): string[] {
  return [
    ...new Set([provider.providerName, ...(provider.providerNames ?? [])]),
  ];
}

function isUserProviderRecord(record: ProviderResponse): boolean {
  return record.provider_category !== "base";
}

export function providerIsConnectedToRecord(
  provider: ByokProvider,
  record: ProviderResponse | undefined,
  target: ProviderStorageTarget,
): record is ProviderResponse {
  if (!record || !isUserProviderRecord(record)) return false;
  if (target !== "local" || !record.auth_type) return true;
  return provider.isOAuth === true
    ? record.auth_type === "oauth"
    : record.auth_type !== "oauth";
}

export function connectedRecordsForProvider(
  provider: ByokProvider,
  connectedProviders: ReadonlyMap<string, ProviderResponse>,
  target: ProviderStorageTarget,
): ProviderResponse[] {
  const records: ProviderResponse[] = [];
  const seen = new Set<string>();

  const addRecord = (record: ProviderResponse | undefined) => {
    if (!providerIsConnectedToRecord(provider, record, target)) return;
    if (seen.has(record.id)) return;
    seen.add(record.id);
    records.push(record);
  };

  for (const providerName of uniqueProviderNames(provider)) {
    addRecord(connectedProviders.get(providerName));
  }

  for (const record of connectedProviders.values()) {
    if (record.provider_type === provider.providerType) {
      addRecord(record);
    }
  }

  return records;
}
