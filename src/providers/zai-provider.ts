/**
 * Zai provider management backed by the centralized Letta API seam.
 */

import {
  createProvider,
  deleteProvider,
  getProviderByName,
  type ProviderResponse,
  updateProvider,
} from "../backend/api/providers";

// Provider name constant for Zai coding plan
export const ZAI_PROVIDER_NAME = "zai-coding-plan";

/**
 * Get the zai-coding-plan provider if it exists
 */
export async function getZaiProvider(): Promise<ProviderResponse | null> {
  return getProviderByName(ZAI_PROVIDER_NAME);
}

/**
 * Create the Zai coding plan provider with the given API key
 */
export async function createZaiProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  return createProvider("zai", ZAI_PROVIDER_NAME, apiKey);
}

/**
 * Update an existing Zai provider with a new API key
 */
export async function updateZaiProvider(
  providerId: string,
  apiKey: string,
): Promise<ProviderResponse> {
  return updateProvider(providerId, apiKey);
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
 * Remove the Zai provider (called on /disconnect zai)
 */
export async function removeZaiProvider(): Promise<void> {
  const existing = await getZaiProvider();
  if (existing) {
    await deleteProvider(existing.id);
  }
}
