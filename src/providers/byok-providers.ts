/**
 * BYOK (Bring Your Own Key) Provider Service
 * Unified module for managing custom LLM provider connections
 */

import { getLettaCodeHeaders } from "../agent/http-headers";
import { LETTA_CLOUD_API_URL } from "../auth/oauth";
import { settingsManager } from "../settings-manager";

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

// ── BYOK handle classification helpers ──────────────────────────────────────
// These are used by both the TUI ModelSelector and the WS list_models handler
// to categorize model handles as BYOK vs Letta API.

/** Prefixes that always indicate a BYOK handle (ChatGPT OAuth + lc-* providers) */
export const STATIC_BYOK_PROVIDER_PREFIXES = ["chatgpt-plus-pro/", "lc-"];

/**
 * Maps provider_type → base provider string used in model handles.
 * Used to translate BYOK provider names back to their canonical handle prefix
 * (e.g., "lc-anthropic/claude-sonnet-4" → "anthropic/claude-sonnet-4").
 */
export const PROVIDER_TYPE_TO_BASE_PROVIDER: Record<string, string> = {
  chatgpt_oauth: "chatgpt-plus-pro",
  anthropic: "anthropic",
  openai: "openai",
  zai: "zai",
  zai_coding: "zai",
  google_ai: "google_ai",
  google_vertex: "google_vertex",
  minimax: "minimax",
  moonshot: "moonshot",
  moonshot_coding: "moonshot_coding",
  openrouter: "openrouter",
  bedrock: "bedrock",
};

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

// Response type from the providers API
export interface ProviderResponse {
  id: string;
  name: string;
  provider_type: string;
  api_key?: string;
  base_url?: string;
  access_key?: string;
  region?: string;
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
    headers: getLettaCodeHeaders(apiKey),
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const errorText = await response.text();
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
 * List all BYOK providers for the current user
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
  const providers = await listProviders();
  return providers.find((p) => p.name === providerName) || null;
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
  await providersRequest<{ message: string }>("POST", "/v1/providers/check", {
    provider_type: providerType,
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
  });
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
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>("POST", "/v1/providers", {
    name: providerName,
    provider_type: providerType,
    api_key: apiKey,
    ...(accessKey && { access_key: accessKey }),
    ...(region && { region }),
    ...(profile && { profile }),
  });
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
): Promise<ProviderResponse> {
  return providersRequest<ProviderResponse>(
    "PATCH",
    `/v1/providers/${providerId}`,
    {
      api_key: apiKey,
      ...(accessKey && { access_key: accessKey }),
      ...(region && { region }),
      ...(profile && { profile }),
    },
  );
}

/**
 * Delete a provider by ID
 */
export async function deleteProvider(providerId: string): Promise<void> {
  await providersRequest<void>("DELETE", `/v1/providers/${providerId}`);
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
): Promise<ProviderResponse> {
  const existing = await getProviderByName(providerName);

  if (existing) {
    return updateProvider(existing.id, apiKey, accessKey, region, profile);
  }

  return createProvider(
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
  const existing = await getProviderByName(providerName);
  if (existing) {
    await deleteProvider(existing.id);
  }
}

/**
 * Get provider config by ID
 */
export function getProviderConfig(
  id: ByokProviderId,
): ByokProvider | undefined {
  return BYOK_PROVIDERS.find((p) => p.id === id);
}
