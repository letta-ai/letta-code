/**
 * ChatGPT OAuth provider management backed by the active provider store.
 * API mode stores a chatgpt_oauth provider on Letta; local mode stores OAuth
 * tokens in the local provider auth file and uses a local fetch shim at runtime.
 */

import { getBalanceMetadata } from "@/backend/api/metadata";
import {
  createProvider,
  getProviderByName,
  listProviders,
  type ProviderOperationOptions,
  type ProviderResponse,
  updateProvider,
} from "./byok-providers";
import { OPENAI_CODEX_PROVIDER_NAME } from "./openai-codex-constants";

export { listProviders };

// Provider name constant for letta-code's ChatGPT OAuth provider
export { OPENAI_CODEX_PROVIDER_NAME };

const CHATGPT_OAUTH_PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// Provider type for ChatGPT OAuth (backend handles transformation)
export const CHATGPT_OAUTH_PROVIDER_TYPE = "chatgpt_oauth";

export function normalizeOAuthProviderName(
  providerName?: string | null,
): string {
  const normalized = (providerName ?? OPENAI_CODEX_PROVIDER_NAME).trim();
  if (!normalized) {
    throw new Error("OAuth provider name cannot be empty.");
  }
  if (!CHATGPT_OAUTH_PROVIDER_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "OAuth provider name may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  }
  return normalized;
}

/** @deprecated Use normalizeOAuthProviderName for all named OAuth connections. */
export function normalizeChatGPTOAuthProviderName(
  providerName?: string | null,
): string {
  return normalizeOAuthProviderName(providerName);
}

/**
 * ChatGPT OAuth configuration persisted by the active provider store.
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
export async function getOpenAICodexProvider(
  options: ProviderOperationOptions = {},
  providerName: string = OPENAI_CODEX_PROVIDER_NAME,
): Promise<ProviderResponse | null> {
  return getProviderByName(
    normalizeChatGPTOAuthProviderName(providerName),
    options,
  );
}

/**
 * Create a new ChatGPT OAuth provider
 * OAuth config is JSON-encoded in api_key field for API-mode compatibility.
 */
export async function createOpenAICodexProvider(
  config: ChatGPTOAuthConfig,
  options: ProviderOperationOptions = {},
  providerName: string = OPENAI_CODEX_PROVIDER_NAME,
): Promise<ProviderResponse> {
  return createProvider(
    CHATGPT_OAUTH_PROVIDER_TYPE,
    normalizeChatGPTOAuthProviderName(providerName),
    encodeOAuthConfig(config),
    undefined,
    undefined,
    undefined,
    {},
    options,
  );
}

/**
 * Update an existing ChatGPT OAuth provider with new OAuth config
 * OAuth config is JSON-encoded in api_key field for API-mode compatibility.
 */
export async function updateOpenAICodexProvider(
  providerId: string,
  config: ChatGPTOAuthConfig,
  options: ProviderOperationOptions = {},
): Promise<ProviderResponse> {
  return updateProvider(
    providerId,
    encodeOAuthConfig(config),
    undefined,
    undefined,
    undefined,
    options,
  );
}

/**
 * Create or update the ChatGPT OAuth provider
 * This is the main function called after successful /connect codex
 *
 * In API mode the Letta backend will:
 * 1. Store the OAuth tokens securely
 * 2. Handle token refresh when needed
 * 3. Transform requests from OpenAI format to ChatGPT backend format
 * 4. Add required headers (Authorization, ChatGPT-Account-Id, etc.)
 * 5. Forward to chatgpt.com/backend-api/codex
 */
export async function createOrUpdateOpenAICodexProvider(
  config: ChatGPTOAuthConfig,
  options: ProviderOperationOptions = {},
  providerName: string = OPENAI_CODEX_PROVIDER_NAME,
): Promise<ProviderResponse> {
  const normalizedProviderName =
    normalizeChatGPTOAuthProviderName(providerName);
  const existing = await getOpenAICodexProvider(
    options,
    normalizedProviderName,
  );

  if (existing) {
    if (existing.provider_type !== CHATGPT_OAUTH_PROVIDER_TYPE) {
      throw new Error(
        `Provider '${normalizedProviderName}' already exists with type '${existing.provider_type}'. Choose a different ChatGPT provider name.`,
      );
    }
    return updateOpenAICodexProvider(existing.id, config, options);
  }

  return createOpenAICodexProvider(config, options, normalizedProviderName);
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
