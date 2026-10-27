import { debugWarn } from "@/utils/debug";
import { ApiRequestError, apiRequest } from "./request";

export interface ProviderResponse {
  id: string;
  name: string;
  provider_type: string;
  provider_category?: "base" | "byok" | null;
  auth_type?: "api" | "oauth";
  api_key?: string;
  base_url?: string;
  timeout?: number | false;
  access_key?: string;
  region?: string;
}

export interface ProviderListOptions {
  name?: string;
  providerType?: string;
}

const PROVIDER_PAGE_LIMIT = 50;

async function listProviderPages(
  options: ProviderListOptions,
  request: typeof apiRequest,
): Promise<ProviderResponse[]> {
  const providers: ProviderResponse[] = [];
  let after: string | undefined;

  while (true) {
    const page = await request<ProviderResponse[]>(
      "GET",
      "/v1/providers",
      undefined,
      {
        query: {
          after,
          limit: PROVIDER_PAGE_LIMIT,
          ...(options.name ? { name: options.name } : {}),
          ...(options.providerType
            ? { provider_type: options.providerType }
            : {}),
        },
      },
    );
    providers.push(...page);

    if (page.length < PROVIDER_PAGE_LIMIT) break;
    const nextAfter = page.at(-1)?.id;
    if (!nextAfter || nextAfter === after) break;
    after = nextAfter;
  }

  return providers;
}

export async function listProviders(
  options: ProviderListOptions = {},
  request: typeof apiRequest = apiRequest,
): Promise<ProviderResponse[]> {
  try {
    return await listProviderPages(options, request);
  } catch {
    return [];
  }
}

export async function getProviderById(
  providerId: string,
  request: typeof apiRequest = apiRequest,
): Promise<ProviderResponse | null> {
  try {
    const provider = await request<ProviderResponse>(
      "GET",
      `/v1/providers/${encodeURIComponent(providerId)}`,
    );
    return provider.provider_category === "base" ? null : provider;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

export async function getProviderByName(
  providerName: string,
  request: typeof apiRequest = apiRequest,
): Promise<ProviderResponse | null> {
  const providers = await listProviders({ name: providerName }, request);
  return providers.find((provider) => provider.name === providerName) ?? null;
}

export async function checkProviderApiKey(
  providerType: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  baseURL?: string,
): Promise<void> {
  await apiRequest<{ message: string }>("POST", "/v1/providers/check", {
    provider_type: providerType,
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
    ...(baseURL && { base_url: baseURL }),
  });
}

export async function createProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  baseURL?: string,
): Promise<ProviderResponse> {
  return apiRequest<ProviderResponse>("POST", "/v1/providers", {
    name: providerName,
    provider_type: providerType,
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
    ...(baseURL && { base_url: baseURL }),
  });
}

export async function updateProvider(
  providerId: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  baseURL?: string,
): Promise<ProviderResponse> {
  return apiRequest<ProviderResponse>("PATCH", `/v1/providers/${providerId}`, {
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
    ...(baseURL && { base_url: baseURL }),
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
  baseURL?: string,
): Promise<ProviderResponse> {
  const existing = await getProviderByName(providerName);
  if (existing) {
    return updateProvider(
      existing.id,
      apiKey,
      accessKey,
      region,
      profile,
      baseURL,
    );
  }
  return createProvider(
    providerType,
    providerName,
    apiKey,
    accessKey,
    region,
    profile,
    baseURL,
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
