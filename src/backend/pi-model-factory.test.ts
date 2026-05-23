import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPiEnvOverrides,
  resolvePiModelForAgent,
} from "@/backend/dev/pi-model-factory";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";

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
        "chatgpt-plus-pro/gpt-5.1-codex-max",
        { provider_type: "chatgpt_oauth" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.apiKey).toBe("chatgpt-access-token");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
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

    expect(resolved.provider).toBe("bedrock");
    expect(resolved.model.id).toBe("us.anthropic.claude-opus-4-7");
    expect(resolved.model.reasoning).toBe(true);
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

  test("normalizes local OpenAI-compatible provider base URLs for runtime", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-llama-cpp-base-url-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "llama_cpp",
        providerName: "lc-llama-cpp",
        apiKey: "not-needed",
        baseURL: "http://localhost:8088/",
      });

      const resolved = await resolvePiModelForAgent(
        "llama.cpp/local-model",
        { provider_type: "llama_cpp" },
        { localProviderAuthStorageDir: storageDir },
      );

      expect(resolved.model.baseUrl).toBe("http://localhost:8088/v1");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("does not let local no-key placeholders mask LM Studio env API keys", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-lmstudio-env-key-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "lmstudio",
        providerName: "lc-lmstudio",
        apiKey: "not-needed",
        baseURL: "http://localhost:8000/v1",
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
