/**
 * Direct API calls to Letta for managing OpenAI Codex provider
 * Bypasses SDK since it doesn't expose providers API
 */

import { LETTA_CLOUD_API_URL } from "../auth/oauth";
import { settingsManager } from "../settings-manager";

// Provider name constant for letta-code's OpenAI Codex OAuth provider
export const OPENAI_CODEX_PROVIDER_NAME = "chatgpt-plus-pro";

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
 * Get the chatgpt-plus-pro provider if it exists
 */
export async function getOpenAICodexProvider(): Promise<ProviderResponse | null> {
  const providers = await listProviders();
  return providers.find((p) => p.name === OPENAI_CODEX_PROVIDER_NAME) || null;
}

/**
 * Create a new OpenAI Codex provider with API key
 */
export async function createOpenAICodexProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>("POST", "/v1/providers", {
    name: OPENAI_CODEX_PROVIDER_NAME,
    provider_type: "openai",
    api_key: apiKey,
  });
}

/**
 * Update an existing OpenAI Codex provider with new API key
 */
export async function updateOpenAICodexProvider(
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
 * Delete the OpenAI Codex provider
 */
export async function deleteOpenAICodexProvider(
  providerId: string,
): Promise<void> {
  await providersRequest<void>("DELETE", `/v1/providers/${providerId}`);
}

/**
 * Create or update the OpenAI Codex provider with API key
 * This is the main function called after successful /connect
 */
export async function createOrUpdateOpenAICodexProvider(
  apiKey: string,
): Promise<ProviderResponse> {
  const existing = await getOpenAICodexProvider();

  if (existing) {
    // Update existing provider with new API key
    return updateOpenAICodexProvider(existing.id, apiKey);
  } else {
    // Create new provider
    return createOpenAICodexProvider(apiKey);
  }
}

/**
 * Ensure the OpenAI Codex provider has a valid (non-expired) token
 * Call this before making requests that use the provider
 */
export async function ensureOpenAICodexProviderToken(): Promise<void> {
  const settings = settingsManager.getSettings();
  const tokens = settings.openaiOAuth;

  if (!tokens) {
    // No OpenAI OAuth configured, nothing to do
    return;
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  if (tokens.expires_at < fiveMinutesFromNow && tokens.refresh_token) {
    // Token is expired or about to expire, refresh it
    const { refreshOpenAIToken, exchangeTokenForApiKey } = await import(
      "../auth/openai-oauth"
    );

    try {
      const newTokens = await refreshOpenAIToken(tokens.refresh_token);
      const apiKey = await exchangeTokenForApiKey(newTokens.id_token);
      settingsManager.storeOpenAITokens(newTokens, apiKey);

      // Update the provider with the new API key
      const existing = await getOpenAICodexProvider();
      if (existing) {
        await updateOpenAICodexProvider(existing.id, apiKey);
      }
    } catch (error) {
      console.error("Failed to refresh OpenAI access token:", error);
      // Continue with existing token, it might still work
    }
  }
}

/**
 * Remove the OpenAI Codex provider (called on /disconnect)
 */
export async function removeOpenAICodexProvider(): Promise<void> {
  const existing = await getOpenAICodexProvider();
  if (existing) {
    await deleteOpenAICodexProvider(existing.id);
  }
}

/**
 * Check if user is eligible for OpenAI Codex OAuth
 * Requires Pro or Enterprise billing tier
 */
export async function checkOpenAICodexEligibility(): Promise<EligibilityCheckResult> {
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
      reason: `OpenAI Codex OAuth requires a Pro or Enterprise plan. Current plan: ${balance.billing_tier}`,
    };
  } catch (error) {
    // If we can't check eligibility, allow the flow to continue
    // The provider creation will handle the error appropriately
    console.warn("Failed to check OpenAI Codex OAuth eligibility:", error);
    return {
      eligible: true,
      billing_tier: "unknown",
    };
  }
}
