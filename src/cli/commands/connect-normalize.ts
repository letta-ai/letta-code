import {
  type ByokProvider,
  type ByokProviderId,
  getProviderConfig,
} from "../../providers/byok-providers";

export type ConnectProviderCanonical =
  | "chatgpt"
  | "anthropic"
  | "openai"
  | "zai"
  | "minimax"
  | "gemini"
  | "openrouter"
  | "bedrock";

const ALIAS_TO_CANONICAL: Record<string, ConnectProviderCanonical> = {
  chatgpt: "chatgpt",
  codex: "chatgpt",
  anthropic: "anthropic",
  openai: "openai",
  zai: "zai",
  minimax: "minimax",
  gemini: "gemini",
  openrouter: "openrouter",
  bedrock: "bedrock",
};

const CANONICAL_ORDER: ConnectProviderCanonical[] = [
  "chatgpt",
  "anthropic",
  "openai",
  "zai",
  "minimax",
  "gemini",
  "openrouter",
  "bedrock",
];

function canonicalToByokId(
  canonical: ConnectProviderCanonical,
): ByokProviderId {
  return canonical === "chatgpt" ? "codex" : canonical;
}

export interface ResolvedConnectProvider {
  rawInput: string;
  canonical: ConnectProviderCanonical;
  byokId: ByokProviderId;
  byokProvider: ByokProvider;
}

export function resolveConnectProvider(
  providerToken: string | undefined,
): ResolvedConnectProvider | null {
  if (!providerToken) {
    return null;
  }

  const rawInput = providerToken.trim().toLowerCase();
  if (!rawInput) {
    return null;
  }

  const canonical = ALIAS_TO_CANONICAL[rawInput];
  if (!canonical) {
    return null;
  }

  const byokId = canonicalToByokId(canonical);
  const byokProvider = getProviderConfig(byokId);
  if (!byokProvider) {
    return null;
  }

  return {
    rawInput,
    canonical,
    byokId,
    byokProvider,
  };
}

export function listConnectProvidersForHelp(): string[] {
  return CANONICAL_ORDER.map((provider) => {
    if (provider === "chatgpt") {
      return "chatgpt (alias: codex)";
    }
    return provider;
  });
}

export function listConnectProviderTokens(): string[] {
  return [...CANONICAL_ORDER, "codex"];
}

export function isConnectOAuthProvider(
  provider: ResolvedConnectProvider,
): boolean {
  return provider.canonical === "chatgpt";
}

export function isConnectBedrockProvider(
  provider: ResolvedConnectProvider,
): boolean {
  return provider.canonical === "bedrock";
}

export function isConnectApiKeyProvider(
  provider: ResolvedConnectProvider,
): boolean {
  return (
    !isConnectOAuthProvider(provider) && !isConnectBedrockProvider(provider)
  );
}
