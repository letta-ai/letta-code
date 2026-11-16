import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthSelectPrompt } from "@earendil-works/pi-ai/oauth";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
} from "@/agent/available-models";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  clearRegisteredPiProviders,
  type PiProviderOAuthLoginCallbacks,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { getLocalProviderRecordByName } from "@/backend/local/local-provider-auth-store";
import { runLocalOAuthConnectFlow } from "@/cli/commands/connect-local-oauth";
import type { ByokProvider } from "@/providers/byok-providers";
import { settingsManager } from "@/settings-manager";
import { removeTestDir } from "@/test-utils/test-fs";

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
    clearAvailableModelsCache();
    __testSetBackend(null);
    clearRegisteredPiProviders();
    if (previousStorageDir === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_DIR;
    } else {
      process.env.LETTA_LOCAL_BACKEND_DIR = previousStorageDir;
    }
    await removeTestDir(storageDir);
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

  test("invalidates the available model cache after OAuth login", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    await getAvailableModelHandles();
    expect(getAvailableModelsCacheInfo().hasCache).toBe(true);

    await runLocalOAuthConnectFlow(FAKE_BYOK_PROVIDER, {
      onStatus: () => {},
      openBrowser: async () => {},
    });

    expect(getAvailableModelsCacheInfo().hasCache).toBe(false);
  });
});

const DEVICE_ID = "6a4b1f0e-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const CHATGPT_SIGN_IN: ByokProvider = {
  id: "openai-oauth",
  displayName: "OpenAI (ChatGPT subscription)",
  description: "Connect a subscription account",
  providerType: "openai",
  providerName: "lc-openai",
  isOAuth: true,
  oauthProviderId: "openai",
};

describe("runLocalOAuthConnectFlow with Sign in with ChatGPT", () => {
  let storageDir: string;
  let previousStorageDir: string | undefined;
  const realFetch = globalThis.fetch;
  let restoreDeviceId: (() => void) | undefined;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "letta-chatgpt-oauth-test-"));
    previousStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
  });

  afterEach(async () => {
    restoreDeviceId?.();
    restoreDeviceId = undefined;
    globalThis.fetch = realFetch;
    clearAvailableModelsCache();
    if (previousStorageDir === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_DIR;
    } else {
      process.env.LETTA_LOCAL_BACKEND_DIR = previousStorageDir;
    }
    await removeTestDir(storageDir);
  });

  test.each(["explicit", "stored"])(
    "completes sign-in with the %s device ID",
    async (source) => {
      const deviceId = spyOn(
        settingsManager,
        "getOrCreateDeviceId",
      ).mockReturnValue(DEVICE_ID);
      restoreDeviceId = () => deviceId.mockRestore();
      let authorizeUrl: URL | undefined;
      let exchange: URLSearchParams | undefined;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        exchange = new URLSearchParams(String(init?.body));
        return new Response(
          JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            id_token: "id-token",
            scope:
              "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;

      await runLocalOAuthConnectFlow(CHATGPT_SIGN_IN, {
        onStatus: () => {},
        openBrowser: async (url) => {
          authorizeUrl = new URL(url);
        },
        ...(source === "explicit" ? { getDeviceId: () => DEVICE_ID } : {}),
        onPrompt: async () => {
          if (!authorizeUrl) throw new Error("no authorization URL yet");
          const callback = new URL(
            authorizeUrl.searchParams.get("redirect_uri") ?? "",
          );
          callback.searchParams.set("code", "authorization-code");
          callback.searchParams.set(
            "state",
            authorizeUrl.searchParams.get("state") ?? "",
          );
          callback.searchParams.set("client_id", "oaiapp_issued");
          return callback.toString();
        },
      });

      expect(authorizeUrl?.searchParams.get("client_id")).toBe(
        "dynamic_agent_client",
      );
      expect(authorizeUrl?.searchParams.get("ext_agent_host_id")).toBe(
        `urn:uuid:${DEVICE_ID}`,
      );
      expect(authorizeUrl?.searchParams.get("agent_name_hint")).toBe(
        "Letta Code",
      );
      expect(exchange?.get("client_id")).toBe("oaiapp_issued");
      expect(deviceId).toHaveBeenCalledTimes(source === "stored" ? 1 : 0);
      expect(
        getLocalProviderRecordByName("lc-openai", storageDir),
      ).toMatchObject({
        provider_type: "openai",
        auth: { type: "oauth", clientId: "oaiapp_issued" },
      });
    },
  );
});
