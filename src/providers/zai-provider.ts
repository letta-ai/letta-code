/**
 * Direct API calls to Letta for managing Zai provider
 */

import {
  createOrUpdateProvider,
  getByokProviderBaseUrl,
  getProviderByName,
  type ProviderResponse,
  removeProviderByName,
} from "./byok-providers";

// Legacy wrapper around the shared BYOK provider flow for Z.ai coding plan.
export const ZAI_PROVIDER_NAME = "zai-coding-plan";

/**
 * Get the zai-coding-plan provider if it exists
 */
export async function getZaiProvider(): Promise<ProviderResponse | null> {
  return getProviderByName(ZAI_PROVIDER_NAME);
}

/**
 * Create or update the Zai coding plan provider
 * If provider exists, updates it with the new API key
 * If not, creates a new provider
 */
export async function createOrUpdateZaiProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  return createOrUpdateProvider(
    "zai_coding",
    ZAI_PROVIDER_NAME,
    apiKey,
    undefined,
    undefined,
    undefined,
    getByokProviderBaseUrl("zai-coding"),
  );
}

/**
 * Remove the Zai provider (called on /disconnect zai)
 */
export async function removeZaiProvider(): Promise<void> {
  await removeProviderByName(ZAI_PROVIDER_NAME);
}
