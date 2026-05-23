import { describe, expect, test } from "bun:test";
import { providerApiKeyFromInput } from "@/cli/components/ProviderSelector";
import {
  BYOK_PROVIDERS,
  type ByokProvider,
  defaultProviderApiKey,
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
  const provider = BYOK_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) {
    throw new Error(`Expected provider ${id} to exist`);
  }
  return provider;
}

describe("ProviderSelector local provider API keys", () => {
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
