import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import {
  applyPiEnvOverrides,
  reasoningForSettings,
  resolvePiModelForAgent,
} from "@/backend/dev/pi-model-factory";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import { getProviderOAuthAuth } from "@/backend/dev/pi-oauth";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
  subscribePiProviderRegistry,
  unregisterPiProvider,
  unregisterPiProvidersForOwner,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  createOrUpdateLocalProvider,
  localOAuthAuthFromCredentials,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";

function envValue(key: string): string | undefined {
  return process.env[key];
}

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const restore = applyPiEnvOverrides(updates);
  try {
    return await run();
  } finally {
    restore();
  }
}

describe("pi model factory", () => {
  afterEach(() => {
    clearRegisteredPiProviders();
  });

  test("notifies subscribers when mod provider registry changes", () => {
    const changes: string[] = [];
    const unsubscribe = subscribePiProviderRegistry(() => {
      changes.push("changed");
    });
    const config = {
      baseUrl: "http://localhost:8000/v1",
      apiKey: "not-needed",
      api: "openai-completions" as const,
      models: [
        {
          id: "gemma-4",
          name: "Gemma 4",
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000,
          maxTokens: 8192,
        },
      ],
    };

    try {
      clearRegisteredPiProviders();
      expect(changes).toEqual([]);

      registerPiProvider("lmstudio", config, { id: "owner-1" });
      expect(changes).toHaveLength(1);

      unregisterPiProvider("lmstudio", "other-owner");
      expect(changes).toHaveLength(1);

      unregisterPiProvider("lmstudio", "owner-1");
      expect(changes).toHaveLength(2);

      registerPiProvider("lmstudio", config, { id: "owner-1" });
      registerPiProvider("ollama", config, { id: "owner-2" });
      expect(changes).toHaveLength(4);

      unregisterPiProvidersForOwner("owner-1");
      expect(changes).toHaveLength(5);

      unregisterPiProvidersForOwner("missing-owner");
      expect(changes).toHaveLength(5);

      clearRegisteredPiProviders();
      expect(changes).toHaveLength(6);

      clearRegisteredPiProviders();
      expect(changes).toHaveLength(6);
    } finally {
      unsubscribe();
    }
  });

  test("uses KIMI_API_KEY for Kimi For Coding", async () => {
    await withEnv(
      { KIMI_API_KEY: "kimi-key", MOONSHOT_API_KEY: undefined },
      async () => {
        const resolved = await resolvePiModelForAgent(
          "moonshot_coding/kimi-for-coding",
          { provider_type: "moonshot_coding" },
        );

        expect(resolved.apiKey).toBe("kimi-key");
      },
    );
  });

  test("does not use MOONSHOT_API_KEY for Kimi For Coding", async () => {
    await withEnv(
      { KIMI_API_KEY: undefined, MOONSHOT_API_KEY: "moonshot-key" },
      async () => {
        const resolved = await resolvePiModelForAgent(
          "moonshot_coding/kimi-for-coding",
          { provider_type: "moonshot_coding" },
        );

        expect(resolved.apiKey).toBeUndefined();
      },
    );
  });

  test("resolves ChatGPT OAuth through pi OAuth credentials", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-oauth-"));
    try {
      const model = getModels("openai-codex")[0];
      if (!model) throw new Error("Expected ChatGPT subscription models");

      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "chatgpt_oauth",
        providerName: "chatgpt-plus-pro",
        apiKey: JSON.stringify({
          access_token: "chatgpt-access-token",
          id_token: "chatgpt-id-token",
          refresh_token: "chatgpt-refresh-token",
          account_id: "account-123",
          expires_at: Date.now() + 60_000,
        }),
      });

      const resolved = await resolvePiModelForAgent(
        `chatgpt-plus-pro/${model.id}`,
        { provider_type: "chatgpt_oauth" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.apiKey).toBe("chatgpt-access-token");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("resolves local ChatGPT OAuth GPT-5.6 with max reasoning", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-chatgpt-56-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "chatgpt_oauth",
        providerName: "chatgpt-plus-pro",
        apiKey: JSON.stringify({
          access_token: "chatgpt-access-token",
          id_token: "chatgpt-id-token",
          refresh_token: "chatgpt-refresh-token",
          account_id: "account-123",
          expires_at: Date.now() + 60_000,
        }),
      });

      const resolved = await resolvePiModelForAgent(
        "chatgpt-plus-pro/gpt-5.6-sol",
        { provider_type: "chatgpt_oauth" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.provider).toBe("openai-codex");
      expect(resolved.model.id).toBe("gpt-5.6-sol");
      expect(resolved.model.contextWindow).toBe(272000);
      expect(getSupportedThinkingLevels(resolved.model)).toContain("max");
      expect(
        reasoningForSettings(
          { reasoning_effort: "max" },
          "openai-codex/gpt-5.6-sol",
        ),
      ).toBe("max");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("resolves generic local OAuth credentials through pi OAuth providers", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-anthropic-oauth-"));
    try {
      setLocalOAuthProvider({
        storageDir,
        providerName: "anthropic",
        providerType: "anthropic",
        auth: localOAuthAuthFromCredentials({
          access: "sk-ant-oat-local",
          refresh: "anthropic-refresh-token",
          expires: Date.now() + 60_000,
        }),
      });

      const resolved = await resolvePiModelForAgent(
        "anthropic/claude-sonnet-4-6",
        { provider_type: "anthropic" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.apiKey).toBe("sk-ant-oat-local");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("applies pi OAuth model modifications for GitHub Copilot", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-copilot-oauth-"));
    try {
      const model = getModels("github-copilot")[0];
      if (!model) throw new Error("Expected GitHub Copilot models");

      setLocalOAuthProvider({
        storageDir,
        providerName: "github-copilot",
        providerType: "github-copilot",
        auth: localOAuthAuthFromCredentials({
          access: "tid=1;exp=1;proxy-ep=proxy.enterprise.githubcopilot.com;",
          refresh: "copilot-refresh-token",
          expires: Date.now() + 60_000,
        }),
      });

      const resolved = await resolvePiModelForAgent(
        `github-copilot/${model.id}`,
        { provider_type: "github-copilot" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.apiKey).toBe(
        "tid=1;exp=1;proxy-ep=proxy.enterprise.githubcopilot.com;",
      );
      expect(resolved.model.baseUrl).toBe(
        "https://api.enterprise.githubcopilot.com",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("resolves Anthropic Opus 4.8 from the Pi model catalog", async () => {
    const resolved = await resolvePiModelForAgent("anthropic/claude-opus-4-8", {
      provider_type: "anthropic",
    });

    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model.id).toBe("claude-opus-4-8");
    expect(resolved.model.api).toBe("anthropic-messages");
    expect(resolved.model.reasoning).toBe(true);
    expect(resolved.model.contextWindow).toBe(1000000);
  });

  test("maps local Bedrock IAM records to standard AWS env overrides", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-bedrock-iam-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "bedrock",
        providerName: "lc-bedrock",
        apiKey: "secret-key",
        accessKey: "access-key",
        region: "us-west-2",
      });

      const resolved = await resolvePiModelForAgent(
        "bedrock/us.anthropic.claude-sonnet-4-6",
        { provider_type: "bedrock" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.providerOptions).toMatchObject({ region: "us-west-2" });
      expect(resolved.envOverrides).toMatchObject({
        AWS_ACCESS_KEY_ID: "access-key",
        AWS_SECRET_ACCESS_KEY: "secret-key",
        AWS_REGION: "us-west-2",
        AWS_DEFAULT_REGION: "us-west-2",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("resolves Bedrock Opus 4.7 from the Pi model catalog", async () => {
    const resolved = await resolvePiModelForAgent(
      "bedrock/us.anthropic.claude-opus-4-7",
      { provider_type: "bedrock" },
    );

    expect(resolved.provider).toBe("amazon-bedrock");
    expect(resolved.model.id).toBe("us.anthropic.claude-opus-4-7");
    expect(resolved.model.reasoning).toBe(true);
  });

  test("resolves dated OpenAI registry handles to local Pi catalog aliases", async () => {
    const resolved = await resolvePiModelForAgent(
      "openai/gpt-5-mini-2025-08-07",
      { provider_type: "openai" },
    );

    expect(resolved.provider).toBe("openai");
    expect(resolved.model.id).toBe("gpt-5-mini");
  });

  test("maps local Bedrock profile records to pi provider options", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-bedrock-profile-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "bedrock",
        providerName: "lc-bedrock",
        apiKey: "",
        profile: "dev-profile",
        region: "us-east-1",
      });

      const resolved = await resolvePiModelForAgent(
        "bedrock/us.anthropic.claude-sonnet-4-6",
        { provider_type: "bedrock" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.providerOptions).toMatchObject({
        profile: "dev-profile",
        region: "us-east-1",
      });
      expect(resolved.envOverrides).toMatchObject({
        AWS_PROFILE: "dev-profile",
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-east-1",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("requires a selected model for local endpoint providers", async () => {
    await expect(
      resolvePiModelForAgent(undefined, {
        provider_type: "lmstudio_openai",
      }),
    ).rejects.toThrow(
      'No model selected for provider "lmstudio". Choose an available model with /model.',
    );
  });

  test("uses mod-registered provider capabilities for local OpenAI-compatible models", async () => {
    registerPiProvider("lmstudio", {
      baseUrl: "http://localhost:8000/v1",
      apiKey: "not-needed",
      api: "openai-completions",
      models: [
        {
          id: "gemma-4-26B-A4B-it-oQ6",
          name: "Gemma 4 VLM",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000,
          maxTokens: 8192,
        },
      ],
    });

    const resolved = await resolvePiModelForAgent(
      "lmstudio/gemma-4-26B-A4B-it-oQ6",
      { provider_type: "lmstudio_openai" },
    );

    expect(resolved.provider).toBe("lmstudio");
    expect(resolved.model).toMatchObject({
      id: "gemma-4-26B-A4B-it-oQ6",
      provider: "lmstudio",
      baseUrl: "http://localhost:8000/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 256000,
      maxTokens: 8192,
    });
  });

  test("uses dynamic mod provider models at turn time", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-kilo-dynamic-"));
    try {
      const connections: unknown[] = [];
      registerPiProvider("kilo", {
        baseUrl: "http://localhost:8000/v1",
        apiKey: "KILO_API_KEY",
        api: "openai-completions",
        headers: { "X-Kilo": "KILO_HEADER" },
        listModels(connection) {
          connections.push(connection);
          return [
            {
              id: "dynamic-kilo-code",
              name: "Dynamic Kilo Code",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 64000,
              maxTokens: 4096,
            },
          ];
        },
      });
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "kilo",
        providerName: "kilo",
        apiKey: "stored-kilo-key",
        baseURL: "http://stored-kilo/v1",
      });

      await withEnv(
        { KILO_API_KEY: "env-kilo-key", KILO_HEADER: "header" },
        async () => {
          const resolved = await resolvePiModelForAgent(
            "kilo/dynamic-kilo-code",
            {},
            { localProviderAuthStorageDir: storageDir },
          );

          expect(resolved.apiKey).toBe("stored-kilo-key");
          expect(resolved.model).toMatchObject({
            id: "dynamic-kilo-code",
            provider: "kilo",
            baseUrl: "http://stored-kilo/v1",
            contextWindow: 64000,
            maxTokens: 4096,
            headers: { "X-Kilo": "header" },
          });
        },
      );
      expect(connections).toEqual([
        {
          id: "kilo",
          providerName: "kilo",
          baseUrl: "http://stored-kilo/v1",
          apiKey: "stored-kilo-key",
          headers: { "X-Kilo": "header" },
        },
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("uses mod OAuth credentials at turn time", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-kilo-oauth-"));
    try {
      const refreshes: unknown[] = [];
      registerPiProvider("kilo", {
        baseUrl: "https://api.kilo.dev/v1",
        api: "openai-completions",
        authHeader: true,
        oauth: {
          name: "Kilo",
          login: async () => ({
            access: "login-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          }),
          refreshToken: async (credentials) => {
            refreshes.push(credentials);
            return {
              ...credentials,
              access: "refreshed-token",
              expires: Date.now() + 60_000,
            };
          },
          getApiKey: (credentials) => `oauth:${credentials.access}`,
          modifyModels: (models, credentials) =>
            models.map((model) => ({
              ...model,
              baseUrl: `https://${credentials.access}.kilo.dev/v1`,
            })),
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
      setLocalOAuthProvider({
        storageDir,
        providerName: "kilo",
        providerType: "kilo",
        auth: localOAuthAuthFromCredentials({
          access: "expired-token",
          refresh: "refresh-token",
          expires: Date.now() - 1,
        }),
      });

      const resolved = await resolvePiModelForAgent(
        "kilo/kilo-code",
        {},
        { localProviderAuthStorageDir: storageDir },
      );

      expect(getProviderOAuthAuth("kilo")?.name).toBe("Kilo");
      expect(refreshes).toHaveLength(1);
      expect(resolved.apiKey).toBe("oauth:refreshed-token");
      expect(resolved.model).toMatchObject({
        id: "kilo-code",
        provider: "kilo",
        baseUrl: "https://refreshed-token.kilo.dev/v1",
      });
      // Connection auth is per-request state carried in stream options, not
      // baked into the provider-published Model.
      expect(resolved.headers).toMatchObject({
        Authorization: "Bearer oauth:refreshed-token",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("reports unresolved prefixed model providers clearly", async () => {
    await expect(resolvePiModelForAgent("kilo/kilo-code")).rejects.toThrow(
      'Model provider "kilo" is not registered',
    );
  });

  test("local provider connection base URL overrides mod default", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-lmstudio-mod-url-"));
    try {
      registerPiProvider("lmstudio", {
        baseUrl: "http://localhost:8000/v1",
        apiKey: "not-needed",
        api: "openai-completions",
        models: [
          {
            id: "gemma-4-26B-A4B-it-oQ6",
            name: "Gemma 4 VLM",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      });
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "lmstudio",
        providerName: "lc-lmstudio",
        apiKey: "not-needed",
        baseURL: "http://127.0.0.1:1234/v1",
      });

      const resolved = await resolvePiModelForAgent(
        "lmstudio/gemma-4-26B-A4B-it-oQ6",
        { provider_type: "lmstudio_openai" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.model.baseUrl).toBe("http://127.0.0.1:1234/v1");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("normalizes wrapped llama.cpp handles and custom base URLs", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-llama-cpp-base-url-"));
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "local-model", object: "model" }],
          });
        }
        if (url.pathname === "/props") {
          return Response.json({});
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "llama_cpp",
        providerName: "lc-llama-cpp",
        apiKey: "not-needed",
        baseURL: `http://localhost:${server.port}/`,
      });
      const modelsRuntime = new LocalPiModelsRuntime({ storageDir });

      const native = await resolvePiModelForAgent(
        "llama.cpp/local-model",
        {
          provider_type: "llama_cpp",
          context_window_limit: 128000,
          max_tokens: 32000,
        },
        { localProviderAuthStorageDir: storageDir, modelsRuntime },
      );
      const wrapped = await resolvePiModelForAgent(
        "openai/llama.cpp/local-model",
        {
          provider_type: "llama_cpp",
          context_window_limit: 128000,
          max_tokens: 32000,
        },
        { localProviderAuthStorageDir: storageDir, modelsRuntime },
      );

      expect(native.provider).toBe("llama-cpp");
      expect(wrapped).toEqual(native);
      expect(native.model).toMatchObject({
        id: "local-model",
        api: "openai-completions",
        provider: "llama-cpp",
        baseUrl: `http://localhost:${server.port}/v1`,
        contextWindow: 128000,
        maxTokens: 32000,
      });
    } finally {
      server.stop(true);
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("does not let local no-key placeholders mask LM Studio env API keys", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-lmstudio-env-key-"));
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v0/models") {
          return Response.json({
            object: "list",
            data: [{ id: "local-model", object: "model", type: "llm" }],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "lmstudio",
        providerName: "lc-lmstudio",
        apiKey: "not-needed",
        baseURL: `http://localhost:${server.port}/v1`,
      });

      await withEnv({ LMSTUDIO_API_KEY: "1234" }, async () => {
        const resolved = await resolvePiModelForAgent(
          "lmstudio/local-model",
          { provider_type: "lmstudio" },
          { localProviderAuthStorageDir: storageDir },
        );

        expect(resolved.apiKey).toBe("1234");
      });
    } finally {
      server.stop(true);
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("restores process env overrides", () => {
    const originalRegion = process.env.AWS_REGION;
    delete process.env.AWS_PROFILE;
    process.env.AWS_REGION = "old-region";

    const restore = applyPiEnvOverrides({
      AWS_REGION: "new-region",
      AWS_PROFILE: "new-profile",
    });
    expect(process.env.AWS_REGION).toBe("new-region");
    expect(envValue("AWS_PROFILE")).toBe("new-profile");

    restore();
    expect(process.env.AWS_REGION).toBe("old-region");
    expect(envValue("AWS_PROFILE")).toBeUndefined();

    if (originalRegion === undefined) {
      delete process.env.AWS_REGION;
    } else {
      process.env.AWS_REGION = originalRegion;
    }
  });
});
