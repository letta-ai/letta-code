/**
 * Direct API calls to Letta for managing Anthropic provider
 * Bypasses SDK since it doesn't expose providers API
 */

import { LETTA_CLOUD_API_URL } from "../auth/oauth";
import { settingsManager } from "../settings-manager";

// Provider name constant for letta-code's Anthropic OAuth provider
export const ANTHROPIC_PROVIDER_NAME = "claude-pro-max";

interface ProviderResponse {
  id: string;
  name: string;
  provider_type: string;
  api_key?: string;
  base_url?: string;
}

interface BalanceResponse {
  total_balance: number;
  monthly_credit_balance: number;
  purchased_credit_balance: number;
  billing_tier: string;
}

interface EligibilityCheckResult {
  eligible: boolean;
  billing_tier: string;
  reason?: string;
}

/**
 * Get the Letta API base URL and auth token
 */
function getLettaConfig(): { baseUrl: string; apiKey: string } {
  const settings = settingsManager.getSettings();
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
  const { baseUrl, apiKey } = getLettaConfig();
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

    // Check if this is a pro/enterprise plan limitation error
    if (response.status === 403) {
      try {
        const errorData = JSON.parse(errorText);
        if (
          errorData.error &&
          typeof errorData.error === "string" &&
          errorData.error.includes("only available for pro or enterprise")
        ) {
          throw new Error("PLAN_UPGRADE_REQUIRED");
        }
      } catch (parseError) {
        // If it's not valid JSON or doesn't match our pattern, fall through to generic error
        if (
          parseError instanceof Error &&
          parseError.message === "PLAN_UPGRADE_REQUIRED"
        ) {
          throw parseError;
        }
      }
    }

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
 * List all providers to find if our provider exists
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
 * Get the letta-code-claude provider if it exists
 */
export async function getAnthropicProvider(): Promise<ProviderResponse | null> {
  const providers = await listProviders();
  return providers.find((p) => p.name === ANTHROPIC_PROVIDER_NAME) || null;
}

/**
 * Create a new Anthropic provider with OAuth access token
 */
export async function createAnthropicProvider(
  accessToken: string,
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>("POST", "/v1/providers", {
    name: ANTHROPIC_PROVIDER_NAME,
    provider_type: "anthropic",
    api_key: accessToken,
  });
}

/**
 * Update an existing Anthropic provider with new access token
 */
export async function updateAnthropicProvider(
  providerId: string,
  accessToken: string,
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>(
    "PATCH",
    `/v1/providers/${providerId}`,
    {
      api_key: accessToken,
    },
  );
}

/**
 * Delete the Anthropic provider
 */
export async function deleteAnthropicProvider(
  providerId: string,
): Promise<void> {
  await providersRequest<void>("DELETE", `/v1/providers/${providerId}`);
}

/**
 * Create or update the Anthropic provider with OAuth access token
 * This is the main function called after successful /connect
 */
export async function createOrUpdateAnthropicProvider(
  accessToken: string,
): Promise<ProviderResponse> {
  const existing = await getAnthropicProvider();

  if (existing) {
    // Update existing provider with new token
    return updateAnthropicProvider(existing.id, accessToken);
  } else {
    // Create new provider
    return createAnthropicProvider(accessToken);
  }
}

/**
 * Ensure the Anthropic provider has a valid (non-expired) token
 * Call this before making requests that use the provider
 */
export async function ensureAnthropicProviderToken(): Promise<void> {
  const settings = settingsManager.getSettings();
  const tokens = settings.anthropicOAuth;

  if (!tokens) {
    // No Anthropic OAuth configured, nothing to do
    return;
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  if (tokens.expires_at < fiveMinutesFromNow && tokens.refresh_token) {
    // Token is expired or about to expire, refresh it
    const { refreshAnthropicToken } = await import("../auth/anthropic-oauth");

    try {
      const newTokens = await refreshAnthropicToken(tokens.refresh_token);
      settingsManager.storeAnthropicTokens(newTokens);

      // Update the provider with the new access token
      const existing = await getAnthropicProvider();
      if (existing) {
        await updateAnthropicProvider(existing.id, newTokens.access_token);
      }
    } catch (error) {
      console.error("Failed to refresh Anthropic access token:", error);
      // Continue with existing token, it might still work
    }
  }
}

/**
 * Remove the Anthropic provider (called on /disconnect)
 */
export async function removeAnthropicProvider(): Promise<void> {
  const existing = await getAnthropicProvider();
  if (existing) {
    await deleteAnthropicProvider(existing.id);
  }
}

/**
 * Check if user is eligible for Anthropic OAuth
 * Requires Pro or Enterprise billing tier
 */
export async function checkAnthropicOAuthEligibility(): Promise<EligibilityCheckResult> {
  try {
    const balance = await providersRequest<BalanceResponse>(
      "GET",
      "/v1/metadata/balance",
    );

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
      reason: `Claude OAuth requires a Pro or Enterprise plan. Current plan: ${balance.billing_tier}`,
    };
  } catch (error) {
    // If we can't check eligibility, allow the flow to continue
    // The provider creation will handle the error appropriately
    console.warn("Failed to check Anthropic OAuth eligibility:", error);
    return {
      eligible: true,
      billing_tier: "unknown",
    };
  }
}
