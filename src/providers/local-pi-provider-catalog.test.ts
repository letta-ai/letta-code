import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import {
  getOAuthProvider,
  getOAuthProviders,
} from "@earendil-works/pi-ai/oauth";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  PI_PROVIDER_SPECS,
  PI_TUI_DEFAULT_MODEL_IDS,
  PI_TUI_DEFAULTLESS_PROVIDER_IDS,
  resolveProviderFromProviderType,
} from "@/backend/dev/pi-provider-registry";
import { listLocalModels } from "@/backend/local/local-model-config";
import {
  createOrUpdateLocalProvider,
  localOAuthAuthFromCredentials,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";
import { getProviderConfigs } from "@/providers/byok-providers";

describe("local pi provider catalog", () => {
  afterEach(() => {
    clearRegisteredPiProviders();
  });

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
      expect(spec.defaultModel).toBeDefined();
      if (!spec.defaultModel) continue;
      const modelId = spec.defaultModel.split("/").slice(1).join("/");
      expect(
        getModels(spec.piProvider).some((model) => model.id === modelId),
      ).toBe(true);
    }
  });

  test("built-in provider defaults mirror Pi TUI defaults", () => {
    for (const [provider, modelId] of Object.entries(
      PI_TUI_DEFAULT_MODEL_IDS,
    )) {
      const spec = PI_PROVIDER_SPECS.find((entry) => entry.id === provider);
      expect(spec).toBeDefined();
      expect(spec?.defaultModel).toBe(`${spec?.handlePrefixes[0]}${modelId}`);
      expect(
        getModels(provider as Parameters<typeof getModels>[0]).some(
          (model) => model.id === modelId,
        ),
      ).toBe(true);
    }
  });

  test("pi-ai providers without Pi TUI defaults are explicit", () => {
    const defaultedProviders = new Set(Object.keys(PI_TUI_DEFAULT_MODEL_IDS));

    for (const provider of getProviders()) {
      expect(
        defaultedProviders.has(provider) ||
          PI_TUI_DEFAULTLESS_PROVIDER_IDS.has(provider),
      ).toBe(true);
    }
  });

  test("discoverable local endpoint providers do not have guessed defaults", () => {
    const endpointProviders = new Set([
      "ollama",
      "ollama-cloud",
      "lmstudio",
      "llama-cpp",
    ]);

    for (const spec of PI_PROVIDER_SPECS) {
      if (!endpointProviders.has(spec.id)) continue;
      expect(spec.defaultModel).toBeUndefined();
    }
  });

  test("local Anthropic catalog includes upstream Opus 4.8", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-anthropic-opus-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "test-key",
      });

      const models = await listLocalModels(storageDir);
      expect(
        models.some((model) => model.handle === "anthropic/claude-opus-4-8"),
      ).toBe(true);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("local ChatGPT OAuth catalog includes GPT-5.6 named variants", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-chatgpt-56-"));
    try {
      setLocalOAuthProvider({
        storageDir,
        providerName: "chatgpt-plus-pro",
        providerType: "chatgpt_oauth",
        auth: localOAuthAuthFromCredentials({
          access: "chatgpt-access-token",
          refresh: "chatgpt-refresh-token",
          expires: Date.now() + 60_000,
        }),
      });

      const models = await listLocalModels(storageDir);
      for (const variant of ["sol", "terra", "luna"]) {
        expect(models).toContainEqual(
          expect.objectContaining({
            handle: `openai-codex/gpt-5.6-${variant}`,
            max_context_window: 372000,
            model_endpoint_type: "chatgpt_oauth",
          }),
        );
      }
      expect(
        models.some((model) => model.handle === "openai-codex/gpt-5.6"),
      ).toBe(false);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("local OpenAI catalog includes GPT-5.6 named variants", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-openai-56-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "openai",
        providerName: "lc-openai",
        apiKey: "test-openai-key",
      });

      const models = await listLocalModels(storageDir);
      for (const variant of ["sol", "terra", "luna"]) {
        expect(models).toContainEqual(
          expect.objectContaining({
            handle: `openai/gpt-5.6-${variant}`,
            max_context_window: 272000,
            model_endpoint_type: "openai",
          }),
        );
      }
      expect(models.some((model) => model.handle === "openai/gpt-5.6")).toBe(
        false,
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
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

  test("local /connect configs include registered mod providers", () => {
    registerPiProvider("kilo", {
      name: "Kilo",
      description: "Connect Kilo",
      baseUrl: "https://api.kilo.dev/v1",
      apiKey: "KILO_API_KEY",
      api: "openai-completions",
      connect: {
        fields: [
          { key: "apiKey", label: "Kilo API Key", secret: true },
          { key: "baseUrl", label: "Base URL" },
        ],
      },
      models: [
        {
          id: "kilo-code",
          name: "Kilo Code",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });

    const provider = getProviderConfigs("local").find(
      (candidate) => candidate.id === "kilo",
    );

    expect(provider).toMatchObject({
      id: "kilo",
      displayName: "Kilo",
      description: "Connect Kilo",
      providerType: "kilo",
      providerName: "kilo",
      providerNames: ["kilo"],
      fields: [
        { key: "apiKey", label: "Kilo API Key", secret: true },
        { key: "baseUrl", label: "Base URL" },
      ],
    });
  });

  test("local /connect configs include registered mod OAuth providers", () => {
    registerPiProvider("kilo", {
      name: "Kilo",
      description: "Connect Kilo account",
      baseUrl: "https://api.kilo.dev/v1",
      api: "openai-completions",
      oauth: {
        name: "Kilo",
        login: async () => ({
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        }),
        refreshToken: async (credentials) => credentials,
        getApiKey: (credentials) => String(credentials.access),
      },
      models: [
        {
          id: "kilo-code",
          name: "Kilo Code",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });

    expect(getOAuthProvider("kilo")?.name).toBe("Kilo");

    const provider = getProviderConfigs("local").find(
      (candidate) => candidate.id === "kilo",
    );

    expect(provider).toMatchObject({
      id: "kilo",
      displayName: "Kilo",
      description: "Connect Kilo account",
      providerType: "kilo",
      providerName: "kilo",
      providerNames: ["kilo"],
      isOAuth: true,
      oauthProviderId: "kilo",
      requiresApiKey: false,
    });
    expect(provider?.fields).toBeUndefined();
  });

  test("local /connect configs respect connect false for registered mod OAuth providers", () => {
    registerPiProvider("kilo", {
      name: "Kilo",
      baseUrl: "https://api.kilo.dev/v1",
      api: "openai-completions",
      connect: false,
      oauth: {
        name: "Kilo",
        login: async () => ({
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        }),
        refreshToken: async (credentials) => credentials,
        getApiKey: (credentials) => String(credentials.access),
      },
      models: [
        {
          id: "kilo-code",
          name: "Kilo Code",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });

    expect(getOAuthProvider("kilo")?.name).toBe("Kilo");
    expect(
      getProviderConfigs("local").some((provider) => provider.id === "kilo"),
    ).toBe(false);
  });

  test("local model listing includes dynamic mod provider models when configured", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-kilo-provider-"));
    try {
      const connections: unknown[] = [];
      registerPiProvider("kilo", {
        baseUrl: "https://api.kilo.dev/v1",
        apiKey: "KILO_API_KEY",
        api: "openai-completions",
        listModels(connection) {
          connections.push(connection);
          return [
            {
              id: "dynamic-kilo-code",
              name: "Dynamic Kilo Code",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ];
        },
      });
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "kilo",
        providerName: "kilo",
        apiKey: "kilo-key",
        baseURL: "https://custom.kilo/v1",
      });

      const models = await listLocalModels(storageDir);

      expect(models).toContainEqual({
        handle: "kilo/dynamic-kilo-code",
        max_context_window: 128000,
        model: "kilo/dynamic-kilo-code",
        model_endpoint_type: "kilo",
      });
      expect(connections).toEqual([
        {
          id: "kilo",
          providerName: "kilo",
          baseUrl: "https://custom.kilo/v1",
          apiKey: "kilo-key",
          headers: undefined,
        },
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("local model listing passes mod OAuth api keys to listModels", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-kilo-oauth-"));
    try {
      const connections: unknown[] = [];
      registerPiProvider("kilo", {
        baseUrl: "https://api.kilo.dev/v1",
        api: "openai-completions",
        oauth: {
          login: async () => ({
            access: "login-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          }),
          refreshToken: async (credentials) => credentials,
          getApiKey: (credentials) => `oauth:${credentials.access}`,
        },
        listModels(connection) {
          connections.push(connection);
          return [
            {
              id: "oauth-kilo-code",
              name: "OAuth Kilo Code",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ];
        },
      });
      setLocalOAuthProvider({
        storageDir,
        providerName: "kilo",
        providerType: "kilo",
        auth: localOAuthAuthFromCredentials({
          access: "stored-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        }),
      });

      const models = await listLocalModels(storageDir);

      expect(models).toContainEqual({
        handle: "kilo/oauth-kilo-code",
        max_context_window: 128000,
        model: "kilo/oauth-kilo-code",
        model_endpoint_type: "kilo",
      });
      expect(connections).toEqual([
        {
          id: "kilo",
          providerName: "kilo",
          baseUrl: "https://api.kilo.dev/v1",
          apiKey: "oauth:stored-token",
          headers: undefined,
        },
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
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
