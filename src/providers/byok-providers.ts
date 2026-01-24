/**
 * BYOK (Bring Your Own Key) Provider Service
 * Unified module for managing custom LLM provider connections
 */

import { LETTA_CLOUD_API_URL } from "../auth/oauth";
import { settingsManager } from "../settings-manager";

// Provider configuration for the /connect UI
export const BYOK_PROVIDERS = [
  {
    id: "codex",
    displayName: "ChatGPT / Codex plan",
    description: "Connect your ChatGPT coding plan",
    providerType: "chatgpt_oauth",
    providerName: "chatgpt-plus-pro",
    isOAuth: true,
  },
  {
    id: "anthropic",
    displayName: "Claude API",
    description: "Connect an Anthropic API key",
    providerType: "anthropic",
    providerName: "lc-anthropic",
  },
  {
    id: "openai",
    displayName: "OpenAI API",
    description: "Connect an OpenAI API key",
    providerType: "openai",
    providerName: "lc-openai",
  },
  {
    id: "zai",
    displayName: "zAI API",
    description: "Connect a zAI key or coding plan",
    providerType: "zai",
    providerName: "lc-zai",
  },
  {
    id: "gemini",
    displayName: "Gemini API",
    description: "Connect a Google Gemini API key",
    providerType: "google_ai",
    providerName: "lc-gemini",
  },
] as const;

export type ByokProviderId = (typeof BYOK_PROVIDERS)[number]["id"];
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

// Response type from the providers API
export interface ProviderResponse {
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
 * List all BYOK providers for the current user
 */
export async function listProviders(): Promise<ProviderResponse[]> {
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
 * Get a map of connected providers by name
 */
export async function getConnectedProviders(): Promise<
  Map<string, ProviderResponse>
> {
  const providers = await listProviders();
  const map = new Map<string, ProviderResponse>();
  for (const provider of providers) {
    map.set(provider.name, provider);
  }
  return map;
}

/**
 * Check if a specific BYOK provider is connected
 */
export async function isProviderConnected(
  providerName: string,
): Promise<boolean> {
  const providers = await listProviders();
  return providers.some((p) => p.name === providerName);
}

/**
 * Get a provider by name
 */
export async function getProviderByName(
  providerName: string,
): Promise<ProviderResponse | null> {
  const providers = await listProviders();
  return providers.find((p) => p.name === providerName) || null;
}

/**
 * Validate an API key with the provider's check endpoint
 * Returns true if valid, throws error if invalid
 */
export async function checkProviderApiKey(
  providerType: string,
  apiKey: string,
): Promise<void> {
  await providersRequest<{ message: string }>("POST", "/v1/providers/check", {
    provider_type: providerType,
    api_key: apiKey,
  });
}

/**
 * Create a new BYOK provider
 */
export async function createProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>("POST", "/v1/providers", {
    name: providerName,
    provider_type: providerType,
    api_key: apiKey,
  });
}

/**
 * Update an existing provider's API key
 */
export async function updateProvider(
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
 * Delete a provider by ID
 */
export async function deleteProvider(providerId: string): Promise<void> {
  await providersRequest<void>("DELETE", `/v1/providers/${providerId}`);
}

/**
 * Create or update a BYOK provider
 * If provider exists, updates the API key; otherwise creates new
 */
export async function createOrUpdateProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
): Promise<ProviderResponse> {
  const existing = await getProviderByName(providerName);

  if (existing) {
    return updateProvider(existing.id, apiKey);
  }

  return createProvider(providerType, providerName, apiKey);
}

/**
 * Remove a provider by name
 */
export async function removeProviderByName(
  providerName: string,
): Promise<void> {
  const existing = await getProviderByName(providerName);
  if (existing) {
    await deleteProvider(existing.id);
  }
}

/**
 * Get provider config by ID
 */
export function getProviderConfig(
  id: ByokProviderId,
): ByokProvider | undefined {
  return BYOK_PROVIDERS.find((p) => p.id === id);
}
