/**
 * Direct API calls to Letta for managing Zai provider
 */

import { LETTA_CLOUD_API_URL } from "../auth/oauth";
import { settingsManager } from "../settings-manager";

// Provider name constant for Zai coding plan
export const ZAI_PROVIDER_NAME = "zai-coding-plan";

interface ProviderResponse {
  id: string;
  name: string;
  provider_type: string;
  api_key?: string;
  base_url?: string;
}

/**
 * Get the Letta API base URL and auth token
 */
async function getLettaConfig(): Promise<{ baseUrl: string; apiKey: string }> {
  const settings = await settingsManager.getSettingsWithSecureTokens();
  const baseUrl =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY || "";
  return { baseUrl, apiKey };
}

/**
 * Make a request to the Letta providers API
 */
async function providersRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const { baseUrl, apiKey } = await getLettaConfig();
  const url = `${baseUrl}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Letta-Source": "letta-code",
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Provider API error (${response.status}): ${errorText}`);
  }

  // Handle empty responses (e.g., DELETE)
  const text = await response.text();
  if (!text) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

/**
 * List all providers
 */
async function listProviders(): Promise<ProviderResponse[]> {
  try {
    const response = await providersRequest<ProviderResponse[]>(
      "GET",
      "/v1/providers",
    );
    return response;
  } catch {
    return [];
  }
}

/**
 * Get the zai-coding-plan provider if it exists
 */
export async function getZaiProvider(): Promise<ProviderResponse | null> {
  const providers = await listProviders();
  return providers.find((p) => p.name === ZAI_PROVIDER_NAME) || null;
}

/**
 * Create the Zai coding plan provider with the given API key
 */
export async function createZaiProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>("POST", "/v1/providers", {
    name: ZAI_PROVIDER_NAME,
    provider_type: "zai",
    api_key: apiKey,
  });
}

/**
 * Update an existing Zai provider with a new API key
 */
export async function updateZaiProvider(
  providerId: string,
  apiKey: string,
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>(
    "PATCH",
    `/v1/providers/${providerId}`,
    {
      api_key: apiKey,
    },
  );
}

/**
 * Create or update the Zai coding plan provider
 * If provider exists, updates it with the new API key
 * If not, creates a new provider
 */
export async function createOrUpdateZaiProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  const existing = await getZaiProvider();

  if (existing) {
    return updateZaiProvider(existing.id, apiKey);
  }

  return createZaiProvider(apiKey);
}

/**
 * Delete the Zai provider by ID
 */
async function deleteZaiProvider(providerId: string): Promise<void> {
  await providersRequest<void>("DELETE", `/v1/providers/${providerId}`);
}

/**
 * Remove the Zai provider (called on /disconnect zai)
 */
export async function removeZaiProvider(): Promise<void> {
  const existing = await getZaiProvider();
  if (existing) {
    await deleteZaiProvider(existing.id);
  }
}
