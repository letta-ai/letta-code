/**
 * ChatGPT OAuth provider management backed by the centralized Letta API seam.
 * Uses the chatgpt_oauth provider type - backend handles request transformation
 * (transforms OpenAI API format → ChatGPT backend API format)
 */

import { getBalanceMetadata } from "../backend/api/metadata";
import {
  createProvider,
  deleteProvider,
  getProviderByName,
  type ProviderResponse,
} from "../backend/api/providers";
import { apiRequest } from "../backend/api/request";

export { listProviders } from "../backend/api/providers";

// Provider name constant for letta-code's ChatGPT OAuth provider
export const OPENAI_CODEX_PROVIDER_NAME = "chatgpt-plus-pro";

// Provider type for ChatGPT OAuth (backend handles transformation)
export const CHATGPT_OAUTH_PROVIDER_TYPE = "chatgpt_oauth";

/**
 * ChatGPT OAuth configuration sent to Letta backend
 * Backend uses this to authenticate with ChatGPT and transform requests
 */
export interface ChatGPTOAuthConfig {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  account_id: string;
  expires_at: number; // Unix timestamp in milliseconds
}

interface EligibilityCheckResult {
  eligible: boolean;
  billing_tier: string;
  reason?: string;
}

function encodeOAuthConfig(config: ChatGPTOAuthConfig): string {
  return JSON.stringify({
    access_token: config.access_token,
    id_token: config.id_token,
    refresh_token: config.refresh_token,
    account_id: config.account_id,
    expires_at: config.expires_at,
  });
}

/**
 * Get the chatgpt-plus-pro provider if it exists
 */
export async function getOpenAICodexProvider(): Promise<ProviderResponse | null> {
  return getProviderByName(OPENAI_CODEX_PROVIDER_NAME);
}

/**
 * Create a new ChatGPT OAuth provider
 * OAuth config is JSON-encoded in api_key field to avoid backend schema changes
 * Backend parses api_key as JSON when provider_type is "chatgpt_oauth"
 */
export async function createOpenAICodexProvider(
  config: ChatGPTOAuthConfig,
): Promise<ProviderResponse> {
  return createProvider(
    CHATGPT_OAUTH_PROVIDER_TYPE,
    OPENAI_CODEX_PROVIDER_NAME,
    encodeOAuthConfig(config),
  );
}

/**
 * Update an existing ChatGPT OAuth provider with new OAuth config
 * OAuth config is JSON-encoded in api_key field
 */
export async function updateOpenAICodexProvider(
  providerId: string,
  config: ChatGPTOAuthConfig,
): Promise<ProviderResponse> {
  return apiRequest<ProviderResponse>("PATCH", `/v1/providers/${providerId}`, {
    api_key: encodeOAuthConfig(config),
  });
}

/**
 * Delete the ChatGPT OAuth provider
 */
export async function deleteOpenAICodexProvider(
  providerId: string,
): Promise<void> {
  await deleteProvider(providerId);
}

/**
 * Create or update the ChatGPT OAuth provider
 * This is the main function called after successful /connect codex
 *
 * The Letta backend will:
 * 1. Store the OAuth tokens securely
 * 2. Handle token refresh when needed
 * 3. Transform requests from OpenAI format to ChatGPT backend format
 * 4. Add required headers (Authorization, ChatGPT-Account-Id, etc.)
 * 5. Forward to chatgpt.com/backend-api/codex
 */
export async function createOrUpdateOpenAICodexProvider(
  config: ChatGPTOAuthConfig,
): Promise<ProviderResponse> {
  const existing = await getOpenAICodexProvider();

  if (existing) {
    return updateOpenAICodexProvider(existing.id, config);
  }

  return createOpenAICodexProvider(config);
}

/**
 * Remove the ChatGPT OAuth provider (called on /disconnect)
 */
export async function removeOpenAICodexProvider(): Promise<void> {
  const existing = await getOpenAICodexProvider();
  if (existing) {
    await deleteOpenAICodexProvider(existing.id);
  }
}

/**
 * Check if user is eligible for ChatGPT OAuth
 * Requires Pro or Enterprise billing tier
 */
export async function checkOpenAICodexEligibility(): Promise<EligibilityCheckResult> {
  try {
    const balance = await getBalanceMetadata();
    const billingTier = balance.billing_tier.toLowerCase();

    // OAuth is available for pro and enterprise tiers
    if (billingTier === "pro" || billingTier === "enterprise") {
      return {
        eligible: true,
        billing_tier: balance.billing_tier,
      };
    }

    return {
      eligible: false,
      billing_tier: balance.billing_tier,
      reason: `ChatGPT OAuth requires a Pro or Enterprise plan. Current plan: ${balance.billing_tier}`,
    };
  } catch (error) {
    // If we can't check eligibility, allow the flow to continue
    // The provider creation will handle the error appropriately
    console.warn("Failed to check ChatGPT OAuth eligibility:", error);
    return {
      eligible: true,
      billing_tier: "unknown",
    };
  }
}
