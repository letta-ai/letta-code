import { getBalanceMetadata } from "@/backend/api/metadata";
import type { ChatGPTOAuthConfig } from "@/types/chatgpt-oauth";

export type { ChatGPTOAuthConfig } from "@/types/chatgpt-oauth";

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

export { OPENAI_CODEX_PROVIDER_NAME };

const CHATGPT_OAUTH_PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

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

export async function getOpenAICodexProvider(
  options: ProviderOperationOptions = {},
  providerName: string = OPENAI_CODEX_PROVIDER_NAME,
): Promise<ProviderResponse | null> {
  return getProviderByName(
    normalizeChatGPTOAuthProviderName(providerName),
    options,
  );
}

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

export async function checkOpenAICodexEligibility(): Promise<EligibilityCheckResult> {
  try {
    const balance = await getBalanceMetadata();
    const billingTier = balance.billing_tier.toLowerCase();

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
    console.warn("Failed to check ChatGPT OAuth eligibility:", error);
    return {
      eligible: true,
      billing_tier: "unknown",
    };
  }
}
