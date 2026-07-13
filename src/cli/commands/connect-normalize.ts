import {
  type ByokProvider,
  type ByokProviderId,
  defaultProviderApiKey,
  defaultProviderStorageTarget,
  getProviderConfig,
  getProviderConfigs,
  type ProviderStorageTarget,
} from "@/providers/byok-providers";

export type ConnectProviderCanonical = string;

const ALIAS_TO_CANONICAL: Record<string, ConnectProviderCanonical> = {
  chatgpt: "chatgpt",
  codex: "chatgpt",
  "openai-codex": "chatgpt",
  ollama: "ollama",
  "ollama-cloud": "ollama-cloud",
  lmstudio: "lmstudio",
  "llama-cpp": "llama-cpp",
  "llama.cpp": "llama-cpp",
  llamacpp: "llama-cpp",
};

const LOCAL_ALIAS_TO_CANONICAL: Record<string, ConnectProviderCanonical> = {
  claude: "anthropic-oauth",
  gemini: "google",
  "kimi-code": "kimi-coding",
  moonshot: "moonshotai",
  bedrock: "amazon-bedrock",
};

function providerMatches(provider: ByokProvider, token: string): boolean {
  if (provider.id === token) return true;
  if (provider.oauthProviderId === token) return true;
  if (provider.providerType === token) return true;
  if (provider.providerName === token) return true;
  return false;
}

function findChatGPTProvider(
  target: ProviderStorageTarget,
): ByokProvider | undefined {
  return getProviderConfigs(target).find(
    (provider) =>
      provider.oauthProviderId === "openai-codex" ||
      provider.providerType === "chatgpt_oauth",
  );
}

export interface ResolvedConnectProvider {
  rawInput: string;
  canonical: ConnectProviderCanonical;
  byokId: ByokProviderId;
  byokProvider: ByokProvider;
  target: ProviderStorageTarget;
}

export function resolveConnectProvider(
  providerToken: string | undefined,
  target: ProviderStorageTarget = defaultProviderStorageTarget(),
): ResolvedConnectProvider | null {
  if (!providerToken) {
    return null;
  }

  const rawInput = providerToken.trim().toLowerCase();
  if (!rawInput) {
    return null;
  }

  const canonical =
    ALIAS_TO_CANONICAL[rawInput] ??
    (target === "local" ? LOCAL_ALIAS_TO_CANONICAL[rawInput] : undefined) ??
    rawInput;
  const byokProvider =
    canonical === "chatgpt"
      ? findChatGPTProvider(target)
      : (getProviderConfigs(target).find((provider) =>
          providerMatches(provider, canonical),
        ) ?? getProviderConfig(canonical, target));
  if (!byokProvider) {
    return null;
  }

  return {
    rawInput,
    canonical,
    byokId: byokProvider.id,
    byokProvider,
    target,
  };
}

export function listConnectProvidersForHelp(
  target: ProviderStorageTarget = defaultProviderStorageTarget(),
): string[] {
  const providers = getProviderConfigs(target).map((provider) => provider.id);
  if (providers.includes("codex") || providers.includes("openai-codex-oauth")) {
    return [
      "chatgpt (alias: codex)",
      ...providers.filter(
        (provider) => provider !== "codex" && provider !== "openai-codex-oauth",
      ),
    ];
  }
  return providers;
}

export function listConnectProviderTokens(
  target: ProviderStorageTarget = defaultProviderStorageTarget(),
): string[] {
  return [...listConnectProvidersForHelp(target), "codex"];
}

export function isConnectOAuthProvider(
  provider: ResolvedConnectProvider,
): boolean {
  return provider.byokProvider.isOAuth === true;
}

export function isConnectBedrockProvider(
  provider: ResolvedConnectProvider,
): boolean {
  return (
    provider.byokProvider.providerType === "bedrock" ||
    provider.byokProvider.providerType === "amazon-bedrock"
  );
}

export function isConnectApiKeyProvider(
  provider: ResolvedConnectProvider,
): boolean {
  return (
    !isConnectOAuthProvider(provider) && !isConnectBedrockProvider(provider)
  );
}

export function defaultConnectApiKey(
  provider: ResolvedConnectProvider,
): string | undefined {
  return defaultProviderApiKey(provider.byokProvider);
}

export function isConnectZaiBaseProvider(
  provider: ResolvedConnectProvider,
): boolean {
  return provider.byokProvider.providerType === "zai";
}
