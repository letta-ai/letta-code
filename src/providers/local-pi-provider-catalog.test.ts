import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import {
  PI_PROVIDER_SPECS,
  resolveProviderFromProviderType,
} from "@/backend/dev/pi-provider-registry";
import { listLocalModels } from "@/backend/local/local-model-config";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import { getProviderConfigs } from "@/providers/byok-providers";

describe("local pi provider catalog", () => {
  test("Constellation /connect configs exclude local-only providers", () => {
    const apiProviderIds = new Set(
      getProviderConfigs("api").map((provider) => provider.id),
    );

    expect(apiProviderIds.has("ollama")).toBe(false);
    expect(apiProviderIds.has("ollama-cloud")).toBe(false);
    expect(apiProviderIds.has("lmstudio")).toBe(false);
    expect(apiProviderIds.has("llama-cpp")).toBe(false);
  });

  test("local /connect configs cover every upstream pi-ai provider", () => {
    const coveredProviders = new Set(
      getProviderConfigs("local")
        .map((provider) =>
          resolveProviderFromProviderType(provider.providerType),
        )
        .filter((provider) => provider !== undefined),
    );

    for (const provider of getProviders()) {
      expect(coveredProviders.has(provider)).toBe(true);
    }
  });

  test("local /connect configs cover every upstream pi-ai OAuth provider", () => {
    const localOAuthProviderIds = new Set(
      getProviderConfigs("local")
        .filter((provider) => provider.isOAuth)
        .map((provider) => provider.oauthProviderId),
    );

    for (const provider of getOAuthProviders()) {
      expect(localOAuthProviderIds.has(provider.id)).toBe(true);
    }
  });

  test("local provider defaults point at current pi-ai catalog models", () => {
    for (const spec of PI_PROVIDER_SPECS) {
      if (!spec.piProvider) continue;
      const modelId = spec.defaultModel.split("/").slice(1).join("/");
      expect(
        getModels(spec.piProvider).some((model) => model.id === modelId),
      ).toBe(true);
    }
  });

  test("local /connect API-key providers mirror Pi TUI OAuth split", () => {
    const localApiKeyProviderIds = new Set(
      getProviderConfigs("local")
        .filter((provider) => !provider.isOAuth)
        .map((provider) => provider.id),
    );

    expect(localApiKeyProviderIds.has("anthropic")).toBe(true);
    expect(localApiKeyProviderIds.has("openai-codex")).toBe(false);
    expect(localApiKeyProviderIds.has("github-copilot")).toBe(false);
  });

  test("local model listing uses the upstream pi-ai catalog for generic providers", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-pi-provider-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "deepseek",
        providerName: "deepseek",
        apiKey: "deepseek-key",
      });

      const handles = (await listLocalModels(storageDir)).map(
        (model) => model.handle,
      );

      expect(handles).toContain("deepseek/deepseek-v4-flash");
      expect(handles).toContain("deepseek/deepseek-v4-pro");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
