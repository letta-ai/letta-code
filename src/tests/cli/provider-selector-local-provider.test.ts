import { describe, expect, test } from "bun:test";
import { providerApiKeyFromInput } from "../../cli/components/ProviderSelector";
import {
  BYOK_PROVIDERS,
  type ByokProvider,
  defaultProviderApiKey,
} from "../../providers/byok-providers";

function providerById(id: string): ByokProvider {
  const provider = BYOK_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) {
    throw new Error(`Expected provider ${id} to exist`);
  }
  return provider;
}

describe("ProviderSelector local provider API keys", () => {
  test("uses default key placeholders for API-key optional local providers", () => {
    expect(defaultProviderApiKey(providerById("ollama"))).toBe("not-needed");
    expect(defaultProviderApiKey(providerById("lmstudio"))).toBe("not-needed");
    expect(defaultProviderApiKey(providerById("llama-cpp"))).toBe("not-needed");
  });

  test("allows blank input only when the selected provider has a default key", () => {
    expect(providerApiKeyFromInput(providerById("lmstudio"), "")).toBe(
      "not-needed",
    );
    expect(providerApiKeyFromInput(providerById("ollama"), "   ")).toBe(
      "not-needed",
    );
    expect(providerApiKeyFromInput(providerById("openai"), "")).toBe(undefined);
  });

  test("uses explicitly typed keys over local provider defaults", () => {
    expect(providerApiKeyFromInput(providerById("lmstudio"), " lm-key ")).toBe(
      "lm-key",
    );
  });
});
