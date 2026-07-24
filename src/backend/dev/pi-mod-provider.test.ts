import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { localModelSettingsForHandle } from "@/backend/local/local-model-config";
import { setLocalOAuthProvider } from "@/backend/local/local-provider-auth-store";
import { testRefreshContext } from "@/test-utils/pi-refresh-context";
import { createModPiProvider } from "./pi-mod-provider";
import { resolvePiModelForAgent } from "./pi-model-factory";
import { LocalPiModelsRuntime } from "./pi-models-runtime";
import {
  getRegisteredPiProvider,
  type PiProviderModelRegistration,
  registerPiProvider,
  unregisterPiProvider,
} from "./pi-provider-mod-registry";

const PROVIDER = "modtest-acme";

function oauthAccount(account: string) {
  return {
    type: "oauth" as const,
    access: `access-${account}`,
    refresh: `refresh-${account}`,
    expires: Date.now() + 3_600_000,
  };
}

function model(
  id: string,
  overrides: Partial<PiProviderModelRegistration> = {},
): PiProviderModelRegistration {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 16000,
    ...overrides,
  };
}

describe("createModPiProvider", () => {
  afterEach(() => {
    unregisterPiProvider(PROVIDER);
  });

  test("publishes statically declared models as complete pi-ai Models", () => {
    registerPiProvider(PROVIDER, {
      name: "Acme",
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [
        model("acme-large", { input: ["text", "image"], reasoning: true }),
      ],
    });
    const provider = createModPiProvider({
      registered: getRegisteredPiProvider(PROVIDER)!,
    });

    expect(provider.id).toBe(PROVIDER);
    expect(provider.refreshModels).toBeUndefined();
    const published = provider.getModels();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      id: "acme-large",
      provider: PROVIDER,
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 100000,
    });
  });

  test("listModels becomes provider refresh with last-known retention", async () => {
    let fail = false;
    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [model("static-seed")],
      listModels: () => {
        if (fail) throw new Error("endpoint down");
        return [model("dynamic-1", { input: ["text", "image"] })];
      },
    });
    const provider = createModPiProvider({
      registered: getRegisteredPiProvider(PROVIDER)!,
    });
    const refreshContext = testRefreshContext();

    // Static declaration seeds the list before the first refresh.
    expect(provider.getModels().map((m) => m.id)).toEqual(["static-seed"]);

    // pi-ai 0.81 merges the static baseline with the dynamic overlay by id;
    // discoveries extend the declared baseline rather than replacing it.
    await provider.refreshModels?.(refreshContext);
    expect(provider.getModels().map((m) => m.id)).toEqual([
      "static-seed",
      "dynamic-1",
    ]);
    expect(
      provider.getModels().find((m) => m.id === "dynamic-1")?.input,
    ).toEqual(["text", "image"]);

    fail = true;
    await expect(provider.refreshModels?.(refreshContext)).rejects.toThrow(
      "endpoint down",
    );
    expect(provider.getModels().map((m) => m.id)).toEqual([
      "static-seed",
      "dynamic-1",
    ]);
  });
});

describe("LocalPiModelsRuntime mod provider integration", () => {
  afterEach(() => {
    unregisterPiProvider(PROVIDER);
  });

  test("turn resolution returns the provider-published Model instance", async () => {
    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [model("acme-large")],
    });
    const runtime = new LocalPiModelsRuntime();

    const resolved = await resolvePiModelForAgent(
      `${PROVIDER}/acme-large`,
      {},
      { modelsRuntime: runtime },
    );
    expect(resolved.model).toBe(runtime.getModel(PROVIDER, "acme-large")!);
    expect(resolved.model.provider).toBe(PROVIDER);
  });

  test("identity holds through the real selection path (persisted settings)", async () => {
    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [model("acme-large")],
    });
    const runtime = new LocalPiModelsRuntime();

    // Selecting a model persists its derived settings onto the agent —
    // values equal to the published model's. A turn with those settings
    // must still resolve the exact published instance (no clone).
    const persisted = localModelSettingsForHandle(
      `${PROVIDER}/acme-large`,
      runtime,
    );
    expect(persisted).toMatchObject({ context_window_limit: 100000 });

    const resolved = await resolvePiModelForAgent(
      `${PROVIDER}/acme-large`,
      persisted ?? {},
      { modelsRuntime: runtime },
    );
    expect(resolved.model).toBe(runtime.getModel(PROVIDER, "acme-large")!);
  });

  test("OAuth account switch on a dynamic mod drops the old account's catalog", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-mod-oauth-"));
    // Local daemon autodetection must fail instantly so refresh never
    // touches real endpoints; the mod's listModels hook needs no fetch.
    const failingFetch = (async () => {
      throw new Error("no local endpoint in tests");
    }) as unknown as typeof fetch;
    try {
      registerPiProvider(PROVIDER, {
        api: "openai-completions",
        baseUrl: "https://api.acme.test/v1",
        oauth: {
          login: async () => {
            throw new Error("not used in this test");
          },
          refreshToken: async (credentials) => credentials,
          getApiKey: (credentials) => credentials.access,
        },
        listModels: (connection) => {
          // The catalog is account-scoped: only account A publishes.
          if (connection.apiKey !== "access-a") throw new Error("unauthorized");
          return [model("account-a-model")];
        },
      });
      setLocalOAuthProvider({
        providerName: PROVIDER,
        providerType: PROVIDER,
        auth: oauthAccount("a"),
        storageDir,
      });
      const runtime = new LocalPiModelsRuntime({
        storageDir,
        fetchImpl: failingFetch,
      });
      await runtime.refreshAll();
      expect(runtime.getModel(PROVIDER, "account-a-model")).toBeDefined();

      // Log in as account B. The mod reconstruction signature (revision/
      // base URL/API key) cannot see this; credential-identity invalidation
      // must — a turn may never pair B's auth with A's cached catalog.
      setLocalOAuthProvider({
        providerName: PROVIDER,
        providerType: PROVIDER,
        auth: oauthAccount("b"),
        storageDir,
      });
      const turn = await runtime.resolveTurn(PROVIDER, "account-a-model");
      expect(turn.auth?.auth.apiKey).toBe("access-b");
      expect(turn.model).toBeUndefined();
      expect(runtime.getModels(PROVIDER)).toHaveLength(0);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("account switch during turn resolution cannot pair the old catalog with new auth", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-mod-oauth-race-"));
    const failingFetch = (async () => {
      throw new Error("no local endpoint in tests");
    }) as unknown as typeof fetch;
    try {
      registerPiProvider(PROVIDER, {
        api: "openai-completions",
        baseUrl: "https://api.acme.test/v1",
        oauth: {
          login: async () => {
            throw new Error("not used in this test");
          },
          refreshToken: async (credentials) => credentials,
          getApiKey: (credentials) => credentials.access,
        },
        listModels: (connection) => {
          if (connection.apiKey !== "access-a") throw new Error("unauthorized");
          return [model("account-a-model")];
        },
      });
      setLocalOAuthProvider({
        providerName: PROVIDER,
        providerType: PROVIDER,
        auth: oauthAccount("a"),
        storageDir,
      });
      const runtime = new LocalPiModelsRuntime({
        storageDir,
        fetchImpl: failingFetch,
      });
      await runtime.refreshAll();
      expect(runtime.getModel(PROVIDER, "account-a-model")).toBeDefined();

      // Logins are not serialized against turn resolution: complete the
      // switch to account B right after resolveTurn's invalidation snapshot
      // reads account A, so the later auth read inside Models.getAuth sees
      // B while the catalog was validated against A.
      const internals = runtime as unknown as { credentials: CredentialStore };
      const read = internals.credentials.read.bind(internals.credentials);
      let switchAccounts: (() => void) | undefined = () => {
        switchAccounts = undefined;
        setLocalOAuthProvider({
          providerName: PROVIDER,
          providerType: PROVIDER,
          auth: oauthAccount("b"),
          storageDir,
        });
      };
      internals.credentials.read = async (providerId) => {
        const credential = await read(providerId);
        if (providerId === PROVIDER) switchAccounts?.();
        return credential;
      };

      const turn = await runtime.resolveTurn(PROVIDER, "account-a-model");
      expect(turn.auth?.auth.apiKey).toBe("access-b");
      expect(turn.model).toBeUndefined();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("switch during the on-miss catalog refresh resolves a consistent pair", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-mod-oauth-refresh-"));
    const failingFetch = (async () => {
      throw new Error("no local endpoint in tests");
    }) as unknown as typeof fetch;
    try {
      // The login to account B completes while the on-miss refresh is
      // running: the fresh catalog then reflects B while auth was already
      // resolved as A — the mirror image of the auth-read race.
      let switchAccounts: (() => void) | undefined = () => {
        switchAccounts = undefined;
        setLocalOAuthProvider({
          providerName: PROVIDER,
          providerType: PROVIDER,
          auth: oauthAccount("b"),
          storageDir,
        });
      };
      registerPiProvider(PROVIDER, {
        api: "openai-completions",
        baseUrl: "https://api.acme.test/v1",
        oauth: {
          login: async () => {
            throw new Error("not used in this test");
          },
          refreshToken: async (credentials) => credentials,
          getApiKey: (credentials) => credentials.access,
        },
        listModels: (connection) => {
          const account = String(connection.apiKey).replace("access-", "");
          switchAccounts?.();
          return [model(`catalog-${account}`)];
        },
      });
      setLocalOAuthProvider({
        providerName: PROVIDER,
        providerType: PROVIDER,
        auth: oauthAccount("a"),
        storageDir,
      });
      const runtime = new LocalPiModelsRuntime({
        storageDir,
        fetchImpl: failingFetch,
      });

      const turn = await runtime.resolveTurn(PROVIDER, "catalog-b");
      // Resolution retries until auth and catalog come from one identity.
      expect(turn.auth?.auth.apiKey).toBe("access-b");
      expect(turn.model?.id).toBe("catalog-b");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("retry exhaustion fails closed instead of returning a mismatched pair", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-mod-oauth-flap-"));
    const failingFetch = (async () => {
      throw new Error("no local endpoint in tests");
    }) as unknown as typeof fetch;
    try {
      registerPiProvider(PROVIDER, {
        api: "openai-completions",
        baseUrl: "https://api.acme.test/v1",
        oauth: {
          login: async () => {
            throw new Error("not used in this test");
          },
          refreshToken: async (credentials) => credentials,
          getApiKey: (credentials) => credentials.access,
        },
        listModels: (connection) => [
          model(`catalog-${String(connection.apiKey).replace("access-", "")}`),
        ],
      });
      setLocalOAuthProvider({
        providerName: PROVIDER,
        providerType: PROVIDER,
        auth: oauthAccount("a"),
        storageDir,
      });
      const runtime = new LocalPiModelsRuntime({
        storageDir,
        fetchImpl: failingFetch,
      });
      await runtime.refreshAll();
      expect(runtime.getModel(PROVIDER, "catalog-a")).toBeDefined();

      // Pathological flapping: a different account lands after every
      // credential read, so no attempt ever observes one stable identity.
      // Resolution must fail closed rather than return whatever model/auth
      // pairing the final attempt happened to assemble.
      let generation = 0;
      const internals = runtime as unknown as { credentials: CredentialStore };
      const read = internals.credentials.read.bind(internals.credentials);
      internals.credentials.read = async (providerId) => {
        const credential = await read(providerId);
        if (providerId === PROVIDER) {
          generation += 1;
          setLocalOAuthProvider({
            providerName: PROVIDER,
            providerType: PROVIDER,
            auth: oauthAccount(`gen${generation}`),
            storageDir,
          });
        }
        return credential;
      };

      await expect(runtime.resolveTurn(PROVIDER, "catalog-a")).rejects.toThrow(
        "changed repeatedly during turn resolution",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("unregistering a mod that overrides a built-in restores the built-in", async () => {
    try {
      registerPiProvider("openai-codex", {
        api: "openai-codex-responses",
        baseUrl: "https://proxy.example.test",
        models: [model("proxy-model", { api: "openai-codex-responses" })],
      });
      const runtime = new LocalPiModelsRuntime();
      expect(runtime.getModel("openai-codex", "proxy-model")).toBeDefined();

      unregisterPiProvider("openai-codex");
      // The built-in provider (and its catalog) must survive the mod.
      const builtin = runtime.getModels("openai-codex");
      expect(builtin.length).toBeGreaterThan(0);
      expect(builtin.some((m) => m.id === "proxy-model")).toBe(false);
    } finally {
      unregisterPiProvider("openai-codex");
    }
  });

  test("re-registration rebuilds only that provider; unregistration removes it", async () => {
    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v1",
      models: [model("v1-model")],
    });
    const runtime = new LocalPiModelsRuntime();
    expect(runtime.getModel(PROVIDER, "v1-model")).toBeDefined();
    const builtinBefore = runtime.getModels("anthropic");

    registerPiProvider(PROVIDER, {
      api: "openai-completions",
      baseUrl: "https://api.acme.test/v2",
      models: [model("v2-model")],
    });
    expect(runtime.getModel(PROVIDER, "v1-model")).toBeUndefined();
    expect(runtime.getModel(PROVIDER, "v2-model")?.baseUrl).toBe(
      "https://api.acme.test/v2",
    );
    expect(runtime.getModels("anthropic")[0]).toBe(builtinBefore[0]!);
    expect(runtime.getModels("anthropic")).toHaveLength(builtinBefore.length);

    unregisterPiProvider(PROVIDER);
    expect(runtime.isRuntimeManagedProvider(PROVIDER)).toBe(false);
    expect(runtime.getModels(PROVIDER)).toHaveLength(0);
  });
});
