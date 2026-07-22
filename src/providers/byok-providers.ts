/**
 * BYOK (Bring Your Own Key) Provider Service
 * Unified module for managing custom LLM provider connections
 */

import { getProviders } from "@earendil-works/pi-ai/compat";
import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
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
import { listRegisteredPiProviders } from "@/backend/dev/pi-provider-mod-registry";
import {
  getPiProviderSpec,
  LMSTUDIO_OPENAI_PROVIDER_TYPE,
  PI_PROVIDER_SPECS,
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

export type ProviderStorageTarget = "api" | "local";

export interface ProviderConnectionOptions {
  baseURL?: string;
  timeout?: LocalProviderTimeout;
}

export interface ProviderOperationOptions {
  target?: ProviderStorageTarget;
  connection?: ProviderConnectionOptions;
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

export interface ByokProvider {
  id: string;
  displayName: string;
  description: string;
  providerType: string;
  providerName: string;
  providerNames?: readonly string[];
  isOAuth?: boolean;
  oauthProviderId?: string;
  requiresApiKey?: boolean;
  defaultApiKey?: string;
  fields?: ProviderField[];
  authMethods?: AuthMethod[];
}

export type ByokProviderId = string;

const BEDROCK_AUTH_METHODS: AuthMethod[] = [
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
];

// Provider configuration for the Letta Cloud / API provider store.
export const CLOUD_BYOK_PROVIDERS: readonly ByokProvider[] = [
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
    id: "openai-compatible",
    displayName: "OpenAI-compatible API",
    description: "Connect an OpenAI-compatible Chat Completions endpoint",
    providerType: "openai",
    providerName: "lc-openai-compatible",
    fields: [
      { key: "apiKey", label: "API Key", secret: true },
      {
        key: "baseUrl",
        label: "Base URL",
        placeholder: "https://proxy.example.com/v1",
      },
    ],
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
    authMethods: BEDROCK_AUTH_METHODS,
  },
];

// Backwards-compatible export for code/tests that mean the API provider list.
export const BYOK_PROVIDERS = CLOUD_BYOK_PROVIDERS;

const LOCAL_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai-responses": "Azure OpenAI Responses",
  cerebras: "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  google: "Google Gemini",
  "google-vertex": "Google Vertex AI",
  groq: "Groq",
  "github-copilot": "GitHub Copilot",
  huggingface: "Hugging Face",
  "kimi-coding": "Kimi For Coding",
  mistral: "Mistral",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (China)",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI (China)",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  "openai-codex": "ChatGPT Plus/Pro",
  openrouter: "OpenRouter",
  together: "Together AI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-cn": "Xiaomi MiMo Token Plan (China)",
  "xiaomi-token-plan-ams": "Xiaomi MiMo Token Plan (Amsterdam)",
  "xiaomi-token-plan-sgp": "Xiaomi MiMo Token Plan (Singapore)",
  zai: "ZAI",
};

const LOCAL_EXTRA_PROVIDER_CONFIGS: readonly ByokProvider[] = [
  {
    id: "zai-coding",
    displayName: "zAI Coding Plan",
    description: "Connect a zAI Coding plan key",
    providerType: "zai_coding",
    providerName: "zai_coding",
    providerNames: ["zai_coding", "lc-zai-coding"],
  },
  {
    id: "ollama",
    displayName: "Ollama (local)",
    description: "Connect local Ollama at http://localhost:11434/v1",
    providerType: "ollama",
    providerName: "ollama",
    providerNames: ["ollama", "lc-ollama"],
    requiresApiKey: false,
    defaultApiKey: LOCAL_PROVIDER_NO_API_KEY,
  },
  {
    id: "ollama-cloud",
    displayName: "Ollama Cloud",
    description: "Connect an Ollama Cloud API key",
    providerType: "ollama_cloud",
    providerName: "ollama-cloud",
    providerNames: ["ollama-cloud", "lc-ollama-cloud"],
  },
  {
    id: "lmstudio",
    displayName: "LM Studio (local)",
    description: "Connect local LM Studio at http://127.0.0.1:1234/v1",
    providerType: LMSTUDIO_OPENAI_PROVIDER_TYPE,
    providerName: "lmstudio",
    providerNames: ["lmstudio", "lc-lmstudio"],
    requiresApiKey: false,
    defaultApiKey: LOCAL_PROVIDER_NO_API_KEY,
  },
  {
    id: "llama-cpp",
    displayName: "llama.cpp (local)",
    description: "Connect local llama.cpp at http://localhost:8080/v1",
    providerType: "llama_cpp",
    providerName: "llama-cpp",
    providerNames: ["llama-cpp", "lc-llama-cpp"],
    requiresApiKey: false,
    defaultApiKey: LOCAL_PROVIDER_NO_API_KEY,
  },
];

function humanizeProviderId(provider: string): string {
  return provider
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function displayNameForLocalProvider(provider: string): string {
  return LOCAL_PROVIDER_DISPLAY_NAMES[provider] ?? humanizeProviderId(provider);
}

function localProviderDescription(provider: string): string {
  return `Connect a ${displayNameForLocalProvider(provider)} API key`;
}

function byokProviderFromPiSpec(provider: string): ByokProvider | undefined {
  const spec = PI_PROVIDER_SPECS.find((candidate) => candidate.id === provider);
  if (!spec) return undefined;
  return {
    id: provider,
    displayName: displayNameForLocalProvider(provider),
    description: localProviderDescription(provider),
    providerType: spec.providerTypes[0] ?? provider,
    providerName: spec.localProviderNames[0] ?? provider,
    providerNames: spec.localProviderNames,
    ...(provider === "amazon-bedrock"
      ? { authMethods: BEDROCK_AUTH_METHODS }
      : {}),
  };
}

// Pi TUI exposes Anthropic in both subscription and API-key login flows.
// Other OAuth providers are subscription-only in the Pi TUI.
const PI_TUI_API_KEY_OAUTH_PROVIDER_IDS = new Set(["anthropic"]);

function localOAuthConfigId(providerId: string): string {
  if (providerId === "openai-codex") return "openai-codex-oauth";
  if (PI_TUI_API_KEY_OAUTH_PROVIDER_IDS.has(providerId)) {
    return `${providerId}-oauth`;
  }
  return providerId;
}

function localOAuthProviderConfigs(): ByokProvider[] {
  const registeredProviderIds = new Set(
    listRegisteredPiProviders().map((provider) => provider.providerName),
  );
  return getOAuthProviders()
    .filter((provider) => !registeredProviderIds.has(provider.id))
    .map((provider) => {
      const spec = PI_PROVIDER_SPECS.find(
        (candidate) => candidate.piProvider === provider.id,
      );
      const providerName =
        provider.id === "openai-codex"
          ? "chatgpt-plus-pro"
          : (spec?.localProviderNames[0] ?? provider.id);
      return {
        id: localOAuthConfigId(provider.id),
        displayName: provider.name,
        description: "Connect a subscription account",
        providerType: spec?.providerTypes[0] ?? provider.id,
        providerName,
        providerNames:
          provider.id === "openai-codex"
            ? [providerName, "openai-codex"]
            : spec?.localProviderNames,
        isOAuth: true,
        oauthProviderId: provider.id,
      };
    });
}

function localApiKeyProviderIds(): string[] {
  const oauthProviderIds = new Set(
    getOAuthProviders().map((provider) => provider.id),
  );
  return getProviders().filter(
    (provider) =>
      !oauthProviderIds.has(provider) ||
      PI_TUI_API_KEY_OAUTH_PROVIDER_IDS.has(provider),
  );
}

function defaultModProviderFields(providerName: string): ProviderField[] {
  return [
    { key: "apiKey", label: `${providerName} API Key`, secret: true },
    { key: "baseUrl", label: "Base URL" },
  ];
}

function modProviderEnvApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  const value = process.env[apiKey];
  return value && value.length > 0 ? value : undefined;
}

function byokProviderFromRegisteredProvider(
  provider: ReturnType<typeof listRegisteredPiProviders>[number],
): ByokProvider | undefined {
  if (provider.config.connect === false) return undefined;
  const connect =
    provider.config.connect && typeof provider.config.connect === "object"
      ? provider.config.connect
      : undefined;
  const defaultApiKey = modProviderEnvApiKey(provider.config.apiKey);
  const displayName =
    provider.config.name ?? displayNameForLocalProvider(provider.providerName);
  const baseConfig: ByokProvider = {
    id: provider.providerName,
    displayName,
    description: provider.config.description ?? `Connect ${displayName}`,
    providerType: provider.providerName,
    providerName: provider.providerName,
    providerNames: [provider.providerName],
  };
  if (provider.config.oauth) {
    return {
      ...baseConfig,
      isOAuth: true,
      oauthProviderId: provider.providerName,
      requiresApiKey: false,
    };
  }
  return {
    ...baseConfig,
    requiresApiKey: defaultApiKey === undefined,
    ...(defaultApiKey ? { defaultApiKey } : {}),
    fields: connect?.fields ?? defaultModProviderFields(displayName),
  };
}

export function getProviderConfigs(
  target: ProviderStorageTarget = defaultProviderStorageTarget(),
): readonly ByokProvider[] {
  if (target === "api") return CLOUD_BYOK_PROVIDERS;

  const byId = new Map<string, ByokProvider>();
  for (const provider of localOAuthProviderConfigs()) {
    byId.set(provider.id, provider);
  }
  for (const provider of localApiKeyProviderIds()) {
    const config = byokProviderFromPiSpec(provider);
    if (config) byId.set(config.id, config);
  }
  for (const provider of LOCAL_EXTRA_PROVIDER_CONFIGS) {
    byId.set(provider.id, provider);
  }
  for (const provider of listRegisteredPiProviders()) {
    const config = byokProviderFromRegisteredProvider(provider);
    if (config) byId.set(config.id, config);
  }
  return [...byId.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function providerEnvApiKey(provider: ByokProvider): string | undefined {
  const piProvider = resolveProviderFromProviderType(provider.providerType);
  if (!piProvider) return undefined;

  const apiKey = getPiProviderSpec(piProvider).apiKeyEnv?.();
  return apiKey && apiKey.length > 0 ? apiKey : undefined;
}

export function defaultProviderApiKey(
  provider: ByokProvider,
): string | undefined {
  if (provider.requiresApiKey === false) {
    return providerEnvApiKey(provider) ?? provider.defaultApiKey;
  }
  return undefined;
}

export function isLocalProviderStoreEnabled(): boolean {
  return getBackend().capabilities.localModelCatalog;
}

export function defaultProviderStorageTarget(): ProviderStorageTarget {
  return isLocalProviderStoreEnabled() ? "local" : "api";
}

function useLocalProviderStore(
  target = defaultProviderStorageTarget(),
): boolean {
  return target === "local";
}

export function providerStorageTargetLabel(
  target: ProviderStorageTarget = defaultProviderStorageTarget(),
): string {
  return target === "local" ? "local storage" : "Letta";
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

/** Prefixes that always indicate a BYOK handle (subscription aliases + lc-* providers) */
export const STATIC_BYOK_PROVIDER_PREFIXES = [
  "chatgpt-plus-pro/",
  "openai-codex/",
  "lc-",
];

export { PROVIDER_TYPE_TO_BASE_PROVIDER };

/**
 * Build a mapping of BYOK provider names → base provider strings.
 *
 * Default aliases are derived from both Letta Cloud and local provider
 * metadata so all built-in providers are covered. Connected providers are
 * layered on top to support custom provider names.
 */
export function buildByokProviderAliases(
  connectedProviders: Array<
    Pick<ProviderResponse, "name" | "provider_type">
  > = [],
  target: ProviderStorageTarget = defaultProviderStorageTarget(),
): Record<string, string> {
  const aliases: Record<string, string> = {};

  for (const bp of getProviderConfigs(target)) {
    const base = PROVIDER_TYPE_TO_BASE_PROVIDER[bp.providerType];
    if (base) {
      for (const providerName of [
        bp.providerName,
        ...(bp.providerNames ?? []),
      ]) {
        aliases[providerName] = base;
      }
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
 * Matches static prefixes (subscription aliases + lc-* providers) and any
 * provider name present in the alias map.
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
 * List all BYOK providers for the target store.
 */
export async function listProviders(
  options: ProviderOperationOptions = {},
): Promise<ProviderResponse[]> {
  if (useLocalProviderStore(options.target)) {
    return listLocalProviders();
  }
  return listApiProviders();
}

/**
 * Get a map of connected providers by name.
 */
export async function getConnectedProviders(
  options: ProviderOperationOptions = {},
): Promise<Map<string, ProviderResponse>> {
  const providers = await listProviders(options);
  const map = new Map<string, ProviderResponse>();
  for (const provider of providers) {
    map.set(provider.name, provider);
  }
  return map;
}

/**
 * Check if a specific BYOK provider is connected.
 */
export async function isProviderConnected(
  providerName: string,
  options: ProviderOperationOptions = {},
): Promise<boolean> {
  const providers = await listProviders(options);
  return providers.some((p) => p.name === providerName);
}

/**
 * Get a provider by name.
 */
export async function getProviderByName(
  providerName: string,
  options: ProviderOperationOptions = {},
): Promise<ProviderResponse | null> {
  if (useLocalProviderStore(options.target)) {
    return getLocalProviderByName(providerName);
  }
  return getProviderByNameRequest(providerName);
}

/**
 * Validate an API key with the provider's check endpoint.
 * Returns true if valid, throws error if invalid.
 */
export async function checkProviderApiKey(
  providerType: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  options: ProviderOperationOptions = {},
): Promise<void> {
  if (useLocalProviderStore(options.target)) {
    assertLocalProviderSupported(providerType);
    return;
  }
  await checkProviderApiKeyRequest(
    providerType,
    apiKey,
    accessKey,
    region,
    profile,
    options.connection?.baseURL,
  );
}

/**
 * Create a new BYOK provider.
 */
export async function createProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  options: ProviderConnectionOptions = {},
  operationOptions: ProviderOperationOptions = {},
): Promise<ProviderResponse> {
  if (useLocalProviderStore(operationOptions.target)) {
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
    options.baseURL,
  );
}

/**
 * Update an existing provider's API key.
 */
export async function updateProvider(
  providerId: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  storageDirOrOptions?: string | ProviderOperationOptions,
  options: ProviderConnectionOptions = {},
): Promise<ProviderResponse> {
  const operationOptions =
    typeof storageDirOrOptions === "object" ? storageDirOrOptions : {};
  if (useLocalProviderStore(operationOptions.target)) {
    return updateLocalProvider(
      providerId,
      apiKey,
      accessKey,
      region,
      profile,
      typeof storageDirOrOptions === "string" ? storageDirOrOptions : undefined,
      options,
    );
  }
  return updateProviderRequest(
    providerId,
    apiKey,
    accessKey,
    region,
    profile,
    options.baseURL,
  );
}

/**
 * Delete a provider by ID.
 */
export async function deleteProvider(
  providerId: string,
  options: ProviderOperationOptions = {},
): Promise<void> {
  if (useLocalProviderStore(options.target)) {
    await deleteLocalProvider(providerId);
    return;
  }
  await deleteProviderRequest(providerId);
}

/**
 * Create or update a BYOK provider.
 * If provider exists, updates the API key; otherwise creates new.
 */
export async function createOrUpdateProvider(
  providerType: string,
  providerName: string,
  apiKey: string,
  accessKey?: string,
  region?: string,
  profile?: string,
  options: ProviderConnectionOptions = {},
  operationOptions: ProviderOperationOptions = {},
): Promise<ProviderResponse> {
  if (useLocalProviderStore(operationOptions.target)) {
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
    options.baseURL,
  );
}

/**
 * Remove a provider by name.
 */
export async function removeProviderByName(
  providerName: string,
  options: ProviderOperationOptions = {},
): Promise<void> {
  if (useLocalProviderStore(options.target)) {
    await removeLocalProviderByName(providerName);
    return;
  }
  await removeProviderByNameRequest(providerName);
}

/**
 * Get provider config by ID for a target.
 */
export function getProviderConfig(
  id: ByokProviderId,
  target: ProviderStorageTarget = defaultProviderStorageTarget(),
): ByokProvider | undefined {
  return getProviderConfigs(target).find((p) => p.id === id);
}
