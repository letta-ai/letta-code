import { describe, expect, test } from "bun:test";
import { commands } from "@/cli/commands/registry";
import {
  canConnectAnotherProvider,
  connectAnotherProviderOption,
  connectedProviderSummary,
  fieldValuesFromProviderPlaceholders,
  filterProviderConfigs,
  hasConstellationProviderStoreCredentials,
  isChatGPTUsageProvider,
  isProviderTargetLoading,
  nextProviderConnectionName,
  providerApiKeyFromInput,
  providerSelectionFlow,
  shouldShowProviderStoreTabs,
} from "@/cli/components/ProviderSelector";
import {
  type ByokProvider,
  defaultProviderApiKey,
  getProviderConfigs,
  type ProviderResponse,
} from "@/providers/byok-providers";

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

function providerById(id: string): ByokProvider {
  const provider = getProviderConfigs("local").find(
    (candidate) => candidate.id === id,
  );
  if (!provider) {
    throw new Error(`Expected provider ${id} to exist`);
  }
  return provider;
}

describe("ProviderSelector local provider API keys", () => {
  test("recognizes ChatGPT OAuth providers for usage display", () => {
    const chatgpt = providerById("openai-codex-oauth");
    const openai = providerById("openai");

    expect(isChatGPTUsageProvider(chatgpt)).toBe(true);
    expect(isChatGPTUsageProvider(openai)).toBe(false);
  });

  test("keeps LM Studio UI identity while using server provider type", () => {
    const lmstudio = providerById("lmstudio");

    expect(lmstudio.providerNames).toContain("lc-lmstudio");
    expect(lmstudio.providerType).toBe("lmstudio_openai");
  });

  test("uses default key placeholders for API-key optional local providers", () => {
    withEnv(
      {
        OLLAMA_LOCAL_API_KEY: undefined,
        LMSTUDIO_API_KEY: undefined,
        LLAMA_CPP_API_KEY: undefined,
      },
      () => {
        expect(defaultProviderApiKey(providerById("ollama"))).toBe(
          "not-needed",
        );
        expect(defaultProviderApiKey(providerById("lmstudio"))).toBe(
          "not-needed",
        );
        expect(defaultProviderApiKey(providerById("llama-cpp"))).toBe(
          "not-needed",
        );
      },
    );
  });

  test("allows blank input only when the selected provider has a default key", () => {
    withEnv(
      {
        OLLAMA_LOCAL_API_KEY: undefined,
        LMSTUDIO_API_KEY: undefined,
      },
      () => {
        expect(providerApiKeyFromInput(providerById("lmstudio"), "")).toBe(
          "not-needed",
        );
        expect(providerApiKeyFromInput(providerById("ollama"), "   ")).toBe(
          "not-needed",
        );
        expect(providerApiKeyFromInput(providerById("openai"), "")).toBe(
          undefined,
        );
      },
    );
  });

  test("uses environment keys before local provider placeholders", () => {
    withEnv({ LMSTUDIO_API_KEY: "1234" }, () => {
      expect(providerApiKeyFromInput(providerById("lmstudio"), "")).toBe(
        "1234",
      );
    });
  });

  test("uses explicitly typed keys over local provider defaults", () => {
    expect(providerApiKeyFromInput(providerById("lmstudio"), " lm-key ")).toBe(
      "lm-key",
    );
  });
});

describe("ProviderSelector Constellation auth gating", () => {
  test("requires Constellation credentials before showing provider-store tabs", () => {
    const loggedOut = hasConstellationProviderStoreCredentials(
      { env: {}, refreshToken: undefined },
      {},
    );

    expect(loggedOut).toBe(false);
    expect(shouldShowProviderStoreTabs(loggedOut)).toBe(false);
    expect(shouldShowProviderStoreTabs(null)).toBe(false);
  });

  test("accepts env, stored API key, or refresh token as Constellation auth", () => {
    expect(
      hasConstellationProviderStoreCredentials(
        { env: {}, refreshToken: undefined },
        { LETTA_API_KEY: "env-key" },
      ),
    ).toBe(true);
    expect(
      hasConstellationProviderStoreCredentials(
        { env: { LETTA_API_KEY: "stored-key" }, refreshToken: undefined },
        {},
      ),
    ).toBe(true);
    expect(
      hasConstellationProviderStoreCredentials(
        { env: {}, refreshToken: "refresh-token" },
        {},
      ),
    ).toBe(true);
    expect(shouldShowProviderStoreTabs(true)).toBe(true);
  });
});

describe("ProviderSelector provider filtering", () => {
  test("matches local providers by display name and description", () => {
    const providers = getProviderConfigs("local");

    expect(
      filterProviderConfigs(providers, "copilot").map((p) => p.id),
    ).toEqual(["github-copilot"]);
    expect(
      filterProviderConfigs(providers, "subscription").map((p) => p.id),
    ).toEqual(["anthropic-oauth", "openai-codex-oauth", "github-copilot"]);
  });

  test("matches provider aliases and restores all providers for blank query", () => {
    const providers = getProviderConfigs("local");

    expect(
      filterProviderConfigs(providers, "lc-lmstudio").map((p) => p.id),
    ).toEqual(["lmstudio"]);
    expect(filterProviderConfigs(providers, "   ").length).toBe(
      providers.length,
    );
  });
});

describe("ProviderSelector multi-field defaults", () => {
  test("prefills non-secret provider placeholders", () => {
    expect(
      fieldValuesFromProviderPlaceholders([
        { key: "apiKey", label: "API Key", secret: true },
        {
          key: "baseUrl",
          label: "Base URL",
          placeholder: "https://api.example.test/v1",
        },
      ]),
    ).toEqual({ baseUrl: "https://api.example.test/v1" });
  });

  test("does not prefill secret placeholders", () => {
    expect(
      fieldValuesFromProviderPlaceholders([
        {
          key: "apiKey",
          label: "API Key",
          placeholder: "sk-...",
          secret: true,
        },
      ]),
    ).toEqual({});
  });
});

describe("ProviderSelector connected provider actions", () => {
  const codexProvider: ByokProvider = {
    id: "codex",
    displayName: "ChatGPT / Codex plan",
    description: "Connect your ChatGPT coding plan",
    providerType: "chatgpt_oauth",
    providerName: "chatgpt-plus-pro",
    isOAuth: true,
  };
  const chatgptWorkProvider: ProviderResponse = {
    id: "provider-chatgpt-work",
    name: "chatgpt-work",
    provider_type: "chatgpt_oauth",
    provider_category: "byok",
  };
  const chatgptDefaultProvider: ProviderResponse = {
    id: "provider-chatgpt-plus-pro",
    name: "chatgpt-plus-pro",
    provider_type: "chatgpt_oauth",
    provider_category: "byok",
  };

  test("opens options for connected OAuth providers before starting OAuth", () => {
    const codex = getProviderConfigs("api").find(
      (provider) => provider.id === "codex",
    );
    if (!codex) throw new Error("Expected codex provider config");

    expect(providerSelectionFlow(codex)).toBe("oauth");
    expect(providerSelectionFlow(codex, "provider-1")).toBe("options");
  });

  test("opens options for connected API-key providers", () => {
    const openai = getProviderConfigs("api").find(
      (provider) => provider.id === "openai",
    );
    if (!openai) throw new Error("Expected openai provider config");

    expect(providerSelectionFlow(openai)).toBe("input");
    expect(providerSelectionFlow(openai, "provider-2")).toBe("options");
  });

  test("summarizes disconnected providers with their description", () => {
    expect(connectedProviderSummary(codexProvider, [])).toBe(
      "Connect your ChatGPT coding plan",
    );
  });

  test("summarizes a single named provider with its alias", () => {
    expect(connectedProviderSummary(codexProvider, [chatgptWorkProvider])).toBe(
      "Connected (chatgpt-work)",
    );
  });

  test("summarizes the built-in provider name as connected", () => {
    expect(
      connectedProviderSummary(codexProvider, [chatgptDefaultProvider]),
    ).toBe("Connected");
  });

  test("summarizes multiple named providers by count", () => {
    expect(
      connectedProviderSummary(codexProvider, [
        chatgptDefaultProvider,
        chatgptWorkProvider,
      ]),
    ).toBe("2 connected");
  });

  test("surfaces connect-another only for API ChatGPT OAuth providers", () => {
    const openai = getProviderConfigs("api").find(
      (provider) => provider.id === "openai",
    );
    if (!openai) throw new Error("Expected openai provider config");

    expect(canConnectAnotherProvider(codexProvider, "api")).toBe(true);
    expect(canConnectAnotherProvider(codexProvider, "local")).toBe(false);
    expect(canConnectAnotherProvider(openai, "api")).toBe(false);
    expect(connectAnotherProviderOption(codexProvider)).toBe(
      "Connect another ChatGPT / Codex plan",
    );
  });

  test("suggests the next available ChatGPT OAuth provider name", () => {
    expect(nextProviderConnectionName(codexProvider, [])).toBe(
      "chatgpt-plus-pro",
    );
    expect(
      nextProviderConnectionName(codexProvider, [chatgptDefaultProvider]),
    ).toBe("chatgpt-plus-pro-2");
    expect(
      nextProviderConnectionName(codexProvider, [
        chatgptDefaultProvider,
        {
          ...chatgptDefaultProvider,
          id: "provider-chatgpt-plus-pro-2",
          name: "chatgpt-plus-pro-2",
        },
      ]),
    ).toBe("chatgpt-plus-pro-3");
  });

  test("removes the legacy slash disconnect command from discovery", () => {
    expect(commands["/disconnect"]).toBeUndefined();
  });

  test("does not show loading when switching to a cached provider tab", () => {
    expect(
      isProviderTargetLoading({
        selectedTarget: "api",
        connectedProvidersByTarget: { api: new Map() },
        showProviderStoreTabs: true,
      }),
    ).toBe(false);

    expect(
      isProviderTargetLoading({
        selectedTarget: "api",
        connectedProvidersByTarget: {},
        showProviderStoreTabs: true,
      }),
    ).toBe(true);
  });
});
