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
  | "zai-coding"
  | "minimax"
  | "moonshot"
  | "kimi-code"
  | "gemini"
  | "openrouter"
  | "bedrock";

const ALIAS_TO_CANONICAL: Record<string, ConnectProviderCanonical> = {
  chatgpt: "chatgpt",
  codex: "chatgpt",
  anthropic: "anthropic",
  openai: "openai",
  zai: "zai",
  "zai-coding": "zai-coding",
  minimax: "minimax",
  moonshot: "moonshot",
  "kimi-code": "kimi-code",
  gemini: "gemini",
  openrouter: "openrouter",
  bedrock: "bedrock",
};

const CANONICAL_ORDER: ConnectProviderCanonical[] = [
  "chatgpt",
  "anthropic",
  "openai",
  "zai",
  "zai-coding",
  "minimax",
  "moonshot",
  "kimi-code",
  "gemini",
  "openrouter",
  "bedrock",
];

function canonicalToByokId(
  canonical: ConnectProviderCanonical,
): ByokProviderId {
  if (canonical === "chatgpt") return "codex";
  return canonical;
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

export function isConnectZaiBaseProvider(
  provider: ResolvedConnectProvider,
): boolean {
  return provider.canonical === "zai";
}
