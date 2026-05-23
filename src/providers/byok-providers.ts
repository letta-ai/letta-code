/**
 * BYOK (Bring Your Own Key) Provider Service
 * Unified module for managing custom LLM provider connections
 */

import {
  checkProviderApiKey as checkProviderApiKeyRequest,
  createOrUpdateProvider as createOrUpdateProviderRequest,
  createProvider as createProviderRequest,
  deleteProvider as deleteProviderRequest,
  getProviderByName as getProviderByNameRequest,
  listProviders as listApiProviders,
  type ProviderResponse,
  removeProviderByName as removeProviderByNameRequest,
  updateProvider as updateProviderRequest,
} from "@/backend/api/providers";
import { getBackend } from "@/backend/backend";
import {
  getPiProviderSpec,
  PROVIDER_TYPE_TO_BASE_PROVIDER,
  resolveProviderFromProviderType,
} from "@/backend/dev/pi-provider-registry";
import {
  createOrUpdateLocalProvider,
  deleteLocalProvider,
  getLocalProviderByName,
  isLocalProviderTypeSupported,
  LOCAL_PROVIDER_NO_API_KEY,
  listLocalProviders,
  removeLocalProviderByName,
  updateLocalProvider,
} from "@/backend/local/local-provider-auth-store";
import type { LocalProviderTimeout } from "@/backend/local/local-provider-timeout";

export type { ProviderResponse } from "@/backend/api/providers";

export interface ProviderConnectionOptions {
  baseURL?: string;
  timeout?: LocalProviderTimeout;
}

// Field definition for multi-field providers (like Bedrock)
export interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean; // If true, mask input like a password
}

// Auth method definition for providers with multiple auth options
export interface AuthMethod {
  id: string;
  label: string;
  description: string;
  fields: ProviderField[];
}

// Provider configuration for the /connect UI
export const BYOK_PROVIDERS = [
  {
    id: "codex",
    displayName: "ChatGPT / Codex plan",
    description: "Connect your ChatGPT coding plan",
    providerType: "chatgpt_oauth",
    providerName: "chatgpt-plus-pro",
    isOAuth: true,
  },
  {
    id: "anthropic",
    displayName: "Claude API",
    description: "Connect an Anthropic API key",
    providerType: "anthropic",
    providerName: "lc-anthropic",
  },
  {
    id: "openai",
    displayName: "OpenAI API",
    description: "Connect an OpenAI API key",
    providerType: "openai",
    providerName: "lc-openai",
  },
  {
    id: "zai",
    displayName: "zAI API",
    description: "Connect a zAI API key",
    providerType: "zai",
    providerName: "lc-zai",
  },
  {
    id: "zai-coding",
    displayName: "zAI Coding Plan",
    description: "Connect a zAI Coding plan key",
    providerType: "zai_coding",
    providerName: "lc-zai-coding",
  },
  {
    id: "minimax",
    displayName: "MiniMax API",
    description: "Connect a MiniMax key or coding plan",
    providerType: "minimax",
    providerName: "lc-minimax",
  },
  {
    id: "gemini",
    displayName: "Gemini API",
    description: "Connect a Google Gemini API key",
    providerType: "google_ai",
    providerName: "lc-gemini",
  },
  {
    id: "moonshot",
    displayName: "Moonshot AI",
    description: "Connect a Moonshot AI API key",
    providerType: "moonshot",
    providerName: "lc-moonshot",
  },
  {
    id: "kimi-code",
    displayName: "Kimi Code",
    description: "Connect a Kimi Code API key",
    providerType: "moonshot_coding",
    providerName: "lc-kimi-code",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter API",
    description: "Connect an OpenRouter API key",
    providerType: "openrouter",
    providerName: "lc-openrouter",
  },
  {
    id: "ollama",
    displayName: "Ollama (local)",
    description: "Connect local Ollama at http://localhost:11434/v1",
    providerType: "ollama",
    providerName: "lc-ollama",
    requiresApiKey: false,
    defaultApiKey: LOCAL_PROVIDER_NO_API_KEY,
  },
  {
    id: "ollama-cloud",
    displayName: "Ollama Cloud",
    description: "Connect an Ollama Cloud API key",
    providerType: "ollama_cloud",
    providerName: "lc-ollama-cloud",
  },
  {
    id: "lmstudio",
    displayName: "LM Studio (local)",
    description: "Connect local LM Studio at http://127.0.0.1:1234/v1",
    providerType: "lmstudio",
    providerName: "lc-lmstudio",
    requiresApiKey: false,
    defaultApiKey: LOCAL_PROVIDER_NO_API_KEY,
  },
  {
    id: "llama-cpp",
    displayName: "llama.cpp (local)",
    description: "Connect local llama.cpp at http://localhost:8080/v1",
    providerType: "llama_cpp",
    providerName: "lc-llama-cpp",
    requiresApiKey: false,
    defaultApiKey: LOCAL_PROVIDER_NO_API_KEY,
  },
  {
    id: "bedrock",
    displayName: "AWS Bedrock",
    description: "Connect to Claude on Amazon Bedrock",
    providerType: "bedrock",
    providerName: "lc-bedrock",
    authMethods: [
      {
        id: "iam",
        label: "AWS Access Keys",
        description: "Enter access key and secret key manually",
        fields: [
          {
            key: "accessKey",
            label: "AWS Access Key ID",
            placeholder: "AKIA...",
          },
          { key: "apiKey", label: "AWS Secret Access Key", secret: true },
          { key: "region", label: "AWS Region", placeholder: "us-east-1" },
        ],
      },
      {
        id: "profile",
        label: "AWS Profile",
        description: "Load credentials from ~/.aws/credentials",
        fields: [
          { key: "profile", label: "Profile Name", placeholder: "default" },
          { key: "region", label: "AWS Region", placeholder: "us-east-1" },
        ],
      },
    ] as AuthMethod[],
  },
] as const;

export type ByokProviderId = (typeof BYOK_PROVIDERS)[number]["id"];
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

function providerEnvApiKey(provider: ByokProvider): string | undefined {
  const piProvider = resolveProviderFromProviderType(provider.providerType);
  if (!piProvider) return undefined;

  const apiKey = getPiProviderSpec(piProvider).apiKeyEnv?.();
  return apiKey && apiKey.length > 0 ? apiKey : undefined;
}

export function defaultProviderApiKey(
  provider: ByokProvider,
): string | undefined {
  if ("requiresApiKey" in provider && provider.requiresApiKey === false) {
    return (
      providerEnvApiKey(provider) ??
      ("defaultApiKey" in provider
        ? provider.defaultApiKey
        : LOCAL_PROVIDER_NO_API_KEY)
    );
  }
  return undefined;
}

export function isLocalProviderStoreEnabled(): boolean {
  return getBackend().capabilities.localModelCatalog;
}

export function providerStorageTargetLabel(): string {
  return isLocalProviderStoreEnabled() ? "local storage" : "Letta";
}

function assertLocalProviderSupported(providerType: string): void {
  if (!isLocalProviderTypeSupported(providerType)) {
    throw new Error(
      `${providerType} provider connections are not supported in local mode yet.`,
    );
  }
}

// ── BYOK handle classification helpers ──────────────────────────────────────
// These are used by both the TUI ModelSelector and the WS list_models handler
// to categorize model handles as BYOK vs Letta API.

/** Prefixes that always indicate a BYOK handle (ChatGPT OAuth + lc-* providers) */
export const STATIC_BYOK_PROVIDER_PREFIXES = ["chatgpt-plus-pro/", "lc-"];

export { PROVIDER_TYPE_TO_BASE_PROVIDER };

/**
 * Build a mapping of BYOK provider names → base provider strings.
 *
 * Default aliases are derived from BYOK_PROVIDERS metadata so all built-in
 * providers are always covered. Connected providers (from API) are layered on
 * top to support custom provider names (e.g., "openai-sarah" → "openai").
 */
export function buildByokProviderAliases(
  connectedProviders: Array<
    Pick<ProviderResponse, "name" | "provider_type">
  > = [],
): Record<string, string> {
  const aliases: Record<string, string> = {};

  // Seed from built-in BYOK_PROVIDERS so every known provider has an alias
  for (const bp of BYOK_PROVIDERS) {
    const base = PROVIDER_TYPE_TO_BASE_PROVIDER[bp.providerType];
    if (base) {
      aliases[bp.providerName] = base;
    }
  }

  // Layer on connected providers (supports custom names like "openai-sarah")
  for (const provider of connectedProviders) {
    const base = PROVIDER_TYPE_TO_BASE_PROVIDER[provider.provider_type];
    if (base) {
      aliases[provider.name] = base;
    }
  }

  return aliases;
}

/**
 * Check whether a model handle belongs to a BYOK provider.
 * Matches static prefixes (chatgpt-plus-pro/, lc-*) and any provider
 * name present in the alias map.
 */
export function isByokHandleForSelector(
  handle: string,
  byokProviderAliases: Record<string, string>,
): boolean {
  if (
    STATIC_BYOK_PROVIDER_PREFIXES.some((prefix) => handle.startsWith(prefix))
  ) {
    return true;
  }

  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return false;

  const provider = handle.slice(0, slashIndex);
  return provider in byokProviderAliases;
}

/**
 * List all BYOK providers for the current user
 */
export async function listProviders(): Promise<ProviderResponse[]> {
  if (isLocalProviderStoreEnabled()) {
    return listLocalProviders();
  }
  return listApiProviders();
}

/**
 * Get a map of connected providers by name
 */
export async function getConnectedProviders(): Promise<
  Map<string, ProviderResponse>
> {
  const providers = await listProviders();
  const map = new Map<string, ProviderResponse>();
  for (const provider of providers) {
    map.set(provider.name, provider);
  }
  return map;
}

/**
 * Check if a specific BYOK provider is connected
 */
export async function isProviderConnected(
  providerName: string,
): Promise<boolean> {
  const providers = await listProviders();
  return providers.some((p) => p.name === providerName);
}

/**
 * Get a provider by name
 */
export async function getProviderByName(
  providerName: string,
): Promise<ProviderResponse | null> {
  if (isLocalProviderStoreEnabled()) {
    return getLocalProviderByName(providerName);
  }
  return getProviderByNameRequest(providerName);
}

/**
 * Validate an API key with the provider's check endpoint
 * Returns true if valid, throws error if invalid
 */
export async function checkProviderApiKey(
  providerType: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
): Promise<void> {
  if (isLocalProviderStoreEnabled()) {
    assertLocalProviderSupported(providerType);
    return;
  }
  await checkProviderApiKeyRequest(
    providerType,
    apiKey,
    accessKey,
    region,
    profile,
  );
}

/**
 * Create a new BYOK provider
 */
export async function createProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  options: ProviderConnectionOptions = {},
): Promise<ProviderResponse> {
  if (isLocalProviderStoreEnabled()) {
    return createOrUpdateLocalProvider({
      providerType,
      providerName,
      apiKey,
      accessKey,
      region,
      profile,
      baseURL: options.baseURL,
      timeout: options.timeout,
    });
  }
  return createProviderRequest(
    providerType,
    providerName,
    apiKey,
    accessKey,
    region,
    profile,
  );
}

/**
 * Update an existing provider's API key
 */
export async function updateProvider(
  providerId: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  options: ProviderConnectionOptions = {},
): Promise<ProviderResponse> {
  if (isLocalProviderStoreEnabled()) {
    return updateLocalProvider(
      providerId,
      apiKey,
      accessKey,
      region,
      profile,
      undefined,
      options,
    );
  }
  return updateProviderRequest(providerId, apiKey, accessKey, region, profile);
}

/**
 * Delete a provider by ID
 */
export async function deleteProvider(providerId: string): Promise<void> {
  if (isLocalProviderStoreEnabled()) {
    await deleteLocalProvider(providerId);
    return;
  }
  await deleteProviderRequest(providerId);
}

/**
 * Create or update a BYOK provider
 * If provider exists, updates the API key; otherwise creates new
 */
export async function createOrUpdateProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  options: ProviderConnectionOptions = {},
): Promise<ProviderResponse> {
  if (isLocalProviderStoreEnabled()) {
    return createOrUpdateLocalProvider({
      providerType,
      providerName,
      apiKey,
      accessKey,
      region,
      profile,
      baseURL: options.baseURL,
      timeout: options.timeout,
    });
  }
  return createOrUpdateProviderRequest(
    providerType,
    providerName,
    apiKey,
    accessKey,
    region,
    profile,
  );
}

/**
 * Remove a provider by name
 */
export async function removeProviderByName(
  providerName: string,
): Promise<void> {
  if (isLocalProviderStoreEnabled()) {
    await removeLocalProviderByName(providerName);
    return;
  }
  await removeProviderByNameRequest(providerName);
}

/**
 * Get provider config by ID
 */
export function getProviderConfig(
  id: ByokProviderId,
): ByokProvider | undefined {
  return BYOK_PROVIDERS.find((p) => p.id === id);
}
