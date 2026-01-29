/**
 * Direct API calls to Letta for managing OpenRouter provider
 */

import { getLettaCodeHeaders } from "../agent/http-headers";
import { LETTA_CLOUD_API_URL } from "../auth/oauth";
import { settingsManager } from "../settings-manager";

// Provider name constant for OpenRouter
export const OPENROUTER_PROVIDER_NAME = "lc-openrouter";

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
    headers: getLettaCodeHeaders(apiKey),
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
 * Get the lc-openrouter provider if it exists
 */
export async function getOpenrouterProvider(): Promise<ProviderResponse | null> {
  const providers = await listProviders();
  return providers.find((p) => p.name === OPENROUTER_PROVIDER_NAME) || null;
}

/**
 * Create the OpenRouter provider with the given API key
 */
export async function createOpenrouterProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>("POST", "/v1/providers", {
    name: OPENROUTER_PROVIDER_NAME,
    provider_type: "openrouter",
    api_key: apiKey,
  });
}

/**
 * Update an existing OpenRouter provider with a new API key
 */
export async function updateOpenrouterProvider(
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
 * Create or update the OpenRouter provider
 * If provider exists, updates it with the new API key
 * If not, creates a new provider
 */
export async function createOrUpdateOpenrouterProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  const existing = await getOpenrouterProvider();

  if (existing) {
    return updateOpenrouterProvider(existing.id, apiKey);
  }

  return createOpenrouterProvider(apiKey);
}

/**
 * Delete the OpenRouter provider by ID
 */
async function deleteOpenrouterProvider(providerId: string): Promise<void> {
  await providersRequest<void>("DELETE", `/v1/providers/${providerId}`);
}

/**
 * Remove the OpenRouter provider (called on /disconnect openrouter)
 */
export async function removeOpenrouterProvider(): Promise<void> {
  const existing = await getOpenrouterProvider();
  if (existing) {
    await deleteOpenrouterProvider(existing.id);
  }
}
