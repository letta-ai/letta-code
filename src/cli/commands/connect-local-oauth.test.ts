import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import {
  clearRegisteredPiProviders,
  type PiProviderOAuthLoginCallbacks,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { getLocalProviderRecordByName } from "@/backend/local/local-provider-auth-store";
import { runLocalOAuthConnectFlow } from "@/cli/commands/connect-local-oauth";
import type { ByokProvider } from "@/providers/byok-providers";

const FAKE_PROVIDER_ID = "fake-select-oauth";

const FAKE_BYOK_PROVIDER: ByokProvider = {
  id: FAKE_PROVIDER_ID,
  displayName: "Fake Select OAuth",
  description: "Fake OAuth provider for tests",
  providerType: FAKE_PROVIDER_ID,
  providerName: FAKE_PROVIDER_ID,
  isOAuth: true,
  oauthProviderId: FAKE_PROVIDER_ID,
};

const SELECT_PROMPT: OAuthSelectPrompt = {
  message: "Select login method:",
  options: [
    { id: "browser", label: "Browser login (default)" },
    { id: "device_code", label: "Device code login (headless)" },
  ],
};

describe("runLocalOAuthConnectFlow select prompts", () => {
  let storageDir: string;
  let previousStorageDir: string | undefined;
  let selectedMethod: string | undefined;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "letta-local-oauth-test-"));
    previousStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
    selectedMethod = undefined;

    registerPiProvider(FAKE_PROVIDER_ID, {
      name: "Fake Select OAuth",
      description: "Fake OAuth provider for tests",
      baseUrl: "https://fake-select-oauth.test/v1",
      api: "openai-completions",
      oauth: {
        name: "Fake Select OAuth",
        login: async (callbacks: PiProviderOAuthLoginCallbacks) => {
          const method = await callbacks.onSelect(SELECT_PROMPT);
          if (!method) throw new Error("Login cancelled");
          selectedMethod = method;
          return {
            access: "fake-access",
            refresh: "fake-refresh",
            expires: Date.now() + 60_000,
          };
        },
        refreshToken: async (credentials) => credentials,
        getApiKey: (credentials) => String(credentials.access),
      },
      models: [
        {
          id: "fake-model",
          name: "Fake Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });
  });

  afterEach(async () => {
    clearRegisteredPiProviders();
    if (previousStorageDir === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_DIR;
    } else {
      process.env.LETTA_LOCAL_BACKEND_DIR = previousStorageDir;
    }
    await rm(storageDir, { recursive: true, force: true });
  });

  test("auto-selects the first (default) option when no onSelect is provided", async () => {
    const result = await runLocalOAuthConnectFlow(FAKE_BYOK_PROVIDER, {
      onStatus: () => {},
      openBrowser: async () => {},
    });

    expect(selectedMethod).toBe("browser");
    expect(result.providerName).toBe(FAKE_PROVIDER_ID);
  });

  test("uses the caller-provided onSelect when available", async () => {
    const result = await runLocalOAuthConnectFlow(FAKE_BYOK_PROVIDER, {
      onStatus: () => {},
      openBrowser: async () => {},
      onSelect: async (prompt) => {
        expect(prompt.message).toBe("Select login method:");
        return "device_code";
      },
    });

    expect(selectedMethod).toBe("device_code");
    expect(result.providerName).toBe(FAKE_PROVIDER_ID);
  });

  test("persists proxy connection options with OAuth credentials", async () => {
    await runLocalOAuthConnectFlow(FAKE_BYOK_PROVIDER, {
      onStatus: () => {},
      openBrowser: async () => {},
      baseURL: "http://proxy.example.test",
      timeout: 30_000,
    });

    expect(
      getLocalProviderRecordByName(FAKE_PROVIDER_ID, storageDir),
    ).toMatchObject({
      base_url: "http://proxy.example.test",
      timeout: 30_000,
      auth: { type: "oauth" },
    });
  });

  test("persists a named OAuth connection under its alias", async () => {
    const providerName = "fake-select-oauth-work";

    const result = await runLocalOAuthConnectFlow(
      { ...FAKE_BYOK_PROVIDER, providerName },
      {
        onStatus: () => {},
        openBrowser: async () => {},
      },
    );

    expect(result.providerName).toBe(providerName);
    expect(getLocalProviderRecordByName(providerName)?.auth.type).toBe("oauth");
    expect(getLocalProviderRecordByName(FAKE_PROVIDER_ID)).toBeNull();
  });
});
