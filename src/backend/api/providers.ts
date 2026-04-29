import { debugWarn } from "../../utils/debug";
import { apiRequest } from "./request";

export interface ProviderResponse {
  id: string;
  name: string;
  provider_type: string;
  provider_category?: "base" | "byok" | null;
  api_key?: string;
  base_url?: string;
  access_key?: string;
  region?: string;
}

export async function listProviders(): Promise<ProviderResponse[]> {
  try {
    return await apiRequest<ProviderResponse[]>("GET", "/v1/providers");
  } catch {
    return [];
  }
}

export async function getProviderByName(
  providerName: string,
): Promise<ProviderResponse | null> {
  const providers = await listProviders();
  return providers.find((provider) => provider.name === providerName) ?? null;
}

export async function checkProviderApiKey(
  providerType: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
): Promise<void> {
  await apiRequest<{ message: string }>("POST", "/v1/providers/check", {
    provider_type: providerType,
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
  });
}

export async function createProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
): Promise<ProviderResponse> {
  return apiRequest<ProviderResponse>("POST", "/v1/providers", {
    name: providerName,
    provider_type: providerType,
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
  });
}

export async function updateProvider(
  providerId: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
): Promise<ProviderResponse> {
  return apiRequest<ProviderResponse>("PATCH", `/v1/providers/${providerId}`, {
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
  });
}

export async function deleteProvider(providerId: string): Promise<void> {
  await apiRequest<void>("DELETE", `/v1/providers/${providerId}`);
}

export async function createOrUpdateProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
): Promise<ProviderResponse> {
  const existing = await getProviderByName(providerName);
  if (existing) {
    return updateProvider(existing.id, apiKey, accessKey, region, profile);
  }
  return createProvider(
    providerType,
    providerName,
    apiKey,
    accessKey,
    region,
    profile,
  );
}

export async function removeProviderByName(
  providerName: string,
): Promise<void> {
  const existing = await getProviderByName(providerName);
  if (existing) {
    await deleteProvider(existing.id);
  }
}

/**
 * Refresh connected BYOK providers before listing models. The cloud API treats
 * refresh as best-effort, so this helper logs per-provider failures but keeps
 * the caller's model refresh path moving.
 */
export async function refreshByokProviders(): Promise<void> {
  try {
    const providers = await listProviders();
    const byokProviders = providers.filter(
      (provider) => provider.provider_category === "byok",
    );

    await Promise.allSettled(
      byokProviders.map(async (provider) => {
        try {
          await apiRequest<ProviderResponse>(
            "PATCH",
            `/v1/providers/${provider.id}/refresh`,
          );
        } catch (error) {
          debugWarn(
            "available-models",
            `Failed to refresh provider ${provider.name} (${provider.id}):`,
            error,
          );
        }
      }),
    );
  } catch (error) {
    debugWarn(
      "available-models",
      "Failed to list providers for refresh:",
      error,
    );
  }
}
