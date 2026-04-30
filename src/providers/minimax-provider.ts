/**
 * MiniMax provider management backed by the centralized Letta API seam.
 */

import {
  createProvider,
  deleteProvider,
  getProviderByName,
  type ProviderResponse,
  updateProvider,
} from "../backend/api/providers";

// Provider name constant for MiniMax coding plan
export const MINIMAX_PROVIDER_NAME = "minimax-coding-plan";

/**
 * Get the minimax-coding-plan provider if it exists
 */
export async function getMinimaxProvider(): Promise<ProviderResponse | null> {
  return getProviderByName(MINIMAX_PROVIDER_NAME);
}

/**
 * Create the MiniMax coding plan provider with the given API key
 */
export async function createMinimaxProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  return createProvider("minimax", MINIMAX_PROVIDER_NAME, apiKey);
}

/**
 * Update an existing MiniMax provider with a new API key
 */
export async function updateMinimaxProvider(
  providerId: string,
  apiKey: string,
): Promise<ProviderResponse> {
  return updateProvider(providerId, apiKey);
}

/**
 * Create or update the MiniMax coding plan provider
 * If provider exists, updates it with the new API key
 * If not, creates a new provider
 */
export async function createOrUpdateMinimaxProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  const existing = await getMinimaxProvider();

  if (existing) {
    return updateMinimaxProvider(existing.id, apiKey);
  }

  return createMinimaxProvider(apiKey);
}

/**
 * Remove the MiniMax provider (called on /disconnect minimax)
 */
export async function removeMinimaxProvider(): Promise<void> {
  const existing = await getMinimaxProvider();
  if (existing) {
    await deleteProvider(existing.id);
  }
}
