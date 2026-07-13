import { describe, expect, test } from "bun:test";
import {
  defaultConnectApiKey,
  isConnectApiKeyProvider,
  isConnectBedrockProvider,
  isConnectOAuthProvider,
  listConnectProvidersForHelp,
  resolveConnectProvider,
} from "@/cli/commands/connect-normalize";

function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => T,
): T {
  const previous = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("connect provider normalization", () => {
  test("normalizes codex alias to chatgpt provider", () => {
    const resolved = resolveConnectProvider("codex", "api");

    expect(resolved).not.toBeNull();
    if (!resolved) {
      throw new Error("Expected codex alias to resolve");
    }
    expect(resolved?.canonical).toBe("chatgpt");
    expect(resolved?.byokId).toBe("codex");
    expect(resolved?.byokProvider.providerName).toBe("chatgpt-plus-pro");
    expect(isConnectOAuthProvider(resolved)).toBe(true);
  });

  test("normalizes Claude to the local OAuth provider", () => {
    const resolved = resolveConnectProvider("claude", "local");

    expect(resolved).not.toBeNull();
    if (!resolved) throw new Error("Expected Claude OAuth provider");
    expect(resolved.canonical).toBe("anthropic-oauth");
    expect(resolved.byokProvider.oauthProviderId).toBe("anthropic");
    expect(isConnectOAuthProvider(resolved)).toBe(true);
  });

  test("resolves standard api-key providers", () => {
    const anthropic = resolveConnectProvider("anthropic", "api");
    const openrouter = resolveConnectProvider("openrouter", "api");

    if (!anthropic || !openrouter) {
      throw new Error("Expected anthropic and openrouter providers to resolve");
    }

    expect(anthropic?.canonical).toBe("anthropic");
    expect(isConnectApiKeyProvider(anthropic)).toBe(true);

    expect(openrouter?.canonical).toBe("openrouter");
    expect(isConnectApiKeyProvider(openrouter)).toBe(true);
  });

  test("resolves OpenAI-compatible API provider", () => {
    const resolved = resolveConnectProvider("openai-compatible", "api");

    if (!resolved) {
      throw new Error("Expected openai-compatible provider to resolve");
    }

    expect(resolved.canonical).toBe("openai-compatible");
    expect(resolved.byokProvider.providerType).toBe("openai");
    expect(resolved.byokProvider.providerName).toBe("lc-openai-compatible");
    expect(isConnectApiKeyProvider(resolved)).toBe(true);
  });

  test("resolves bedrock as non-api-key provider", () => {
    const bedrock = resolveConnectProvider("bedrock", "api");
    if (!bedrock) {
      throw new Error("Expected bedrock provider to resolve");
    }

    expect(bedrock?.canonical).toBe("bedrock");
    expect(isConnectBedrockProvider(bedrock)).toBe(true);
    expect(isConnectApiKeyProvider(bedrock)).toBe(false);
  });

  test("returns null for unknown provider", () => {
    expect(resolveConnectProvider("unknown-provider", "api")).toBeNull();
  });

  test("does not resolve local-only providers for the API provider store", () => {
    expect(resolveConnectProvider("ollama", "api")).toBeNull();
    expect(resolveConnectProvider("ollama-cloud", "api")).toBeNull();
    expect(resolveConnectProvider("lmstudio", "api")).toBeNull();
    expect(resolveConnectProvider("llama.cpp", "api")).toBeNull();
  });

  test("help list contains chatgpt alias", () => {
    expect(listConnectProvidersForHelp("api")).toContain(
      "chatgpt (alias: codex)",
    );
  });

  test("supports API-key optional local providers", () => {
    withEnv(
      {
        OLLAMA_LOCAL_API_KEY: undefined,
        LMSTUDIO_API_KEY: undefined,
        LLAMA_CPP_API_KEY: undefined,
      },
      () => {
        const ollama = resolveConnectProvider("ollama", "local");
        const lmstudio = resolveConnectProvider("lmstudio", "local");
        const llamaCpp = resolveConnectProvider("llama.cpp", "local");
        if (!ollama || !lmstudio || !llamaCpp) {
          throw new Error("Expected local providers to resolve");
        }

        expect(defaultConnectApiKey(ollama)).toBe("not-needed");
        expect(defaultConnectApiKey(lmstudio)).toBe("not-needed");
        expect(lmstudio.byokProvider.providerType).toBe("lmstudio_openai");
        expect(defaultConnectApiKey(llamaCpp)).toBe("not-needed");
        expect(llamaCpp.canonical).toBe("llama-cpp");
      },
    );
  });

  test("resolves local subscription providers from the pi OAuth catalog", () => {
    const anthropicOAuth = resolveConnectProvider("anthropic-oauth", "local");
    const githubCopilot = resolveConnectProvider("github-copilot", "local");

    if (!anthropicOAuth || !githubCopilot) {
      throw new Error("Expected local OAuth providers to resolve");
    }

    expect(isConnectOAuthProvider(anthropicOAuth)).toBe(true);
    expect(anthropicOAuth.byokProvider.oauthProviderId).toBe("anthropic");
    expect(isConnectOAuthProvider(githubCopilot)).toBe(true);
    expect(githubCopilot.byokProvider.oauthProviderId).toBe("github-copilot");
  });

  test("uses environment keys before API-key optional defaults", () => {
    withEnv({ LMSTUDIO_API_KEY: "1234" }, () => {
      const lmstudio = resolveConnectProvider("lmstudio", "local");
      if (!lmstudio) {
        throw new Error("Expected lmstudio provider to resolve");
      }

      expect(defaultConnectApiKey(lmstudio)).toBe("1234");
    });
  });
});
