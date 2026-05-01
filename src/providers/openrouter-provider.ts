/**
 * OpenRouter provider management backed by the centralized Letta API seam.
 */

import {
  createProvider,
  deleteProvider,
  getProviderByName,
  type ProviderResponse,
  updateProvider,
} from "../backend/api/providers";

// Provider name constant for OpenRouter
export const OPENROUTER_PROVIDER_NAME = "lc-openrouter";

/**
 * Get the lc-openrouter provider if it exists
 */
export async function getOpenrouterProvider(): Promise<ProviderResponse | null> {
  return getProviderByName(OPENROUTER_PROVIDER_NAME);
}

/**
 * Create the OpenRouter provider with the given API key
 */
export async function createOpenrouterProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  return createProvider("openrouter", OPENROUTER_PROVIDER_NAME, apiKey);
}

/**
 * Update an existing OpenRouter provider with a new API key
 */
export async function updateOpenrouterProvider(
  providerId: string,
  apiKey: string,
): Promise<ProviderResponse> {
  return updateProvider(providerId, apiKey);
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
 * Remove the OpenRouter provider (called on /disconnect openrouter)
 */
export async function removeOpenrouterProvider(): Promise<void> {
  const existing = await getOpenrouterProvider();
  if (existing) {
    await deleteProvider(existing.id);
  }
}
