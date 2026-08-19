/**
 * ChatGPT OAuth provider management backed by the active provider store.
 * API mode stores a chatgpt_oauth provider on Letta; local mode stores OAuth
 * tokens in the local provider auth file and uses a local fetch shim at runtime.
 */

import {
  extractAccountIdFromToken,
  refreshChatGPTAccessToken,
} from "@/auth/openai-oauth";
import { getBalanceMetadata } from "@/backend/api/metadata";
import { settingsManager } from "@/settings-manager";
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

export function normalizeChatGPTOAuthProviderName(
  providerName?: string | null,
): string {
  const normalized = (providerName ?? OPENAI_CODEX_PROVIDER_NAME).trim();
  if (!normalized) {
    throw new Error("ChatGPT provider name cannot be empty.");
  }
  if (!CHATGPT_OAUTH_PROVIDER_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "ChatGPT provider name may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  }
  return normalized;
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

// Refresh the access token this many milliseconds before it actually expires.
const CHATGPT_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Single-flight: only one refresh attempt runs at a time across concurrent callers.
let inFlightChatGPTRefresh: Promise<void> | null = null;

/**
 * Refresh the stored ChatGPT OAuth access token if it is about to expire.
 *
 * The harness stores { refreshToken, expiresAt, providerName } in settings
 * when the user connects ChatGPT OAuth, so it can rotate the access token
 * independently rather than relying on the Letta backend to do it.
 *
 * This is a no-op when no ChatGPT OAuth info is stored or when the token
 * still has more than CHATGPT_TOKEN_REFRESH_BUFFER_MS remaining.
 */
export function refreshChatGPTOAuthIfNeeded(
  options: ProviderOperationOptions = {},
  _refresh: typeof refreshChatGPTAccessToken = refreshChatGPTAccessToken,
): Promise<void> {
  if (inFlightChatGPTRefresh) {
    return inFlightChatGPTRefresh;
  }
  const pending = doRefreshIfNeeded(options, _refresh);
  inFlightChatGPTRefresh = pending;
  pending.finally(() => {
    if (inFlightChatGPTRefresh === pending) {
      inFlightChatGPTRefresh = null;
    }
  });
  return pending;
}

async function doRefreshIfNeeded(
  options: ProviderOperationOptions,
  refresh: typeof refreshChatGPTAccessToken,
): Promise<void> {
  const settings = settingsManager.getSettings();
  const stored = settings.chatGPTOAuth;
  if (!stored?.refreshToken) return;

  const now = Date.now();
  if (stored.expiresAt - now > CHATGPT_TOKEN_REFRESH_BUFFER_MS) return;

  let tokens: Awaited<ReturnType<typeof refreshChatGPTAccessToken>>;
  try {
    tokens = await refresh(stored.refreshToken);
  } catch (error) {
    // Best-effort: log but don't crash the caller. The Letta backend may still
    // have a valid token, or will surface an auth error on the next turn.
    console.error(
      "ChatGPT OAuth token refresh failed:",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const newExpiresAt = now + tokens.expires_in * 1000;
  const newRefreshToken = tokens.refresh_token ?? stored.refreshToken;

  // Persist updated rotation state locally.
  settingsManager.updateSettings({
    chatGPTOAuth: {
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
      providerName: stored.providerName,
    },
  });

  // Push the refreshed tokens to the Letta backend so it uses the new
  // access token for subsequent ChatGPT API calls.
  let accountId: string;
  try {
    accountId = extractAccountIdFromToken(tokens.access_token);
  } catch {
    // Fallback: re-use the account ID from the previous config if decoding
    // fails (e.g. the token format changed). The provider update will still
    // carry the new access token.
    const existingProvider = await getOpenAICodexProvider(
      options,
      stored.providerName,
    );
    accountId =
      existingProvider && "account_id" in existingProvider
        ? String(
            (existingProvider as { account_id?: unknown }).account_id ?? "",
          )
        : "";
  }

  await createOrUpdateOpenAICodexProvider(
    {
      access_token: tokens.access_token,
      id_token: tokens.id_token,
      refresh_token: newRefreshToken,
      account_id: accountId,
      expires_at: newExpiresAt,
    },
    options,
    stored.providerName,
  );
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
