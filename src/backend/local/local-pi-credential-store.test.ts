import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { createLocalPiCredentialStore } from "./local-pi-credential-store";
import {
  createOrUpdateLocalProvider,
  getLocalProviderRecordByName,
  localOAuthAuthFromCredentials,
  setLocalOAuthProvider,
} from "./local-provider-auth-store";

describe("createLocalPiCredentialStore", () => {
  const storageDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      storageDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeStorageDir(): Promise<string> {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-cred-store-"));
    storageDirs.push(storageDir);
    return storageDir;
  }

  test("preserves provider-specific OAuth fields round-trip", async () => {
    const storageDir = await makeStorageDir();
    setLocalOAuthProvider({
      storageDir,
      providerName: "github-copilot",
      providerType: "github-copilot",
      auth: localOAuthAuthFromCredentials({
        access: "a",
        refresh: "r",
        expires: Date.now() + 60_000,
        enterpriseUrl: "https://ghe.example.com",
        accountId: "acct",
      } as never),
    });
    const store = createLocalPiCredentialStore(storageDir);

    // pi-ai reads fields like enterpriseUrl during refresh and toAuth; the
    // adapter must not strip them.
    expect(await store.read("github-copilot")).toMatchObject({
      type: "oauth",
      access: "a",
      enterpriseUrl: "https://ghe.example.com",
      accountId: "acct",
    });
  });

  test("modify is serialized per provider", async () => {
    const storageDir = await makeStorageDir();
    setLocalOAuthProvider({
      storageDir,
      providerName: "anthropic",
      providerType: "anthropic",
      auth: localOAuthAuthFromCredentials({
        access: "a",
        refresh: "r",
        expires: Date.now() - 1,
      }),
    });
    const store = createLocalPiCredentialStore(storageDir);

    let inFlight = 0;
    let maxConcurrent = 0;
    const refresh = () =>
      store.modify("anthropic", async (current) => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return current;
      });

    await Promise.all([refresh(), refresh(), refresh()]);
    // The contract requires serialized read-modify-write so concurrent
    // requests cannot double-refresh a rotated token.
    expect(maxConcurrent).toBe(1);
  });

  test("a mod overriding a built-in id keeps that provider's record aliases", async () => {
    const storageDir = await makeStorageDir();
    try {
      registerPiProvider("openai-codex", {
        api: "openai-codex-responses",
        baseUrl: "https://proxy.example.test",
        models: [],
      });
      setLocalOAuthProvider({
        storageDir,
        providerName: "chatgpt-plus-pro",
        providerType: "chatgpt_oauth",
        auth: localOAuthAuthFromCredentials({
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: Date.now() + 60_000,
        }),
      });
      const store = createLocalPiCredentialStore(storageDir);

      expect(await store.read("openai-codex")).toMatchObject({
        type: "oauth",
        access: "chatgpt-access",
      });
    } finally {
      clearRegisteredPiProviders();
    }
  });

  test("api-key modify persists through the provider record", async () => {
    const storageDir = await makeStorageDir();
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "anthropic",
      providerName: "lc-anthropic",
      apiKey: "old-key",
      baseURL: "https://proxy.example.test",
    });
    const store = createLocalPiCredentialStore(storageDir);

    await store.modify("anthropic", async () => ({
      type: "api_key",
      key: "new-key",
    }));

    // The new key persists and non-credential record config survives.
    expect(await store.read("anthropic")).toEqual({
      type: "api_key",
      key: "new-key",
    });
    expect(
      getLocalProviderRecordByName("lc-anthropic", storageDir),
    ).toMatchObject({ base_url: "https://proxy.example.test" });
  });

  test("reads API-key records under aliased pi provider ids", async () => {
    const storageDir = await makeStorageDir();
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "anthropic",
      providerName: "lc-anthropic",
      apiKey: "sk-ant-key",
    });
    const store = createLocalPiCredentialStore(storageDir);

    expect(await store.read("anthropic")).toEqual({
      type: "api_key",
      key: "sk-ant-key",
    });
    expect(await store.read("openai")).toBeUndefined();
    // list() reports pi-ai provider ids, not local record aliases.
    expect(await store.list()).toContainEqual({
      providerId: "anthropic",
      type: "api_key",
    });
  });

  test("modify persists refreshed OAuth credentials back to auth.json", async () => {
    const storageDir = await makeStorageDir();
    setLocalOAuthProvider({
      storageDir,
      providerName: "anthropic",
      providerType: "anthropic",
      auth: localOAuthAuthFromCredentials({
        access: "expired-access",
        refresh: "refresh-token",
        expires: Date.now() - 1,
      }),
    });
    const store = createLocalPiCredentialStore(storageDir);

    const next = await store.modify("anthropic", async (current) => {
      expect(current).toMatchObject({
        type: "oauth",
        access: "expired-access",
      });
      return {
        type: "oauth",
        access: "fresh-access",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      };
    });

    expect(next).toMatchObject({ access: "fresh-access" });
    expect(getLocalProviderRecordByName("anthropic", storageDir)).toMatchObject(
      {
        auth: { type: "oauth", access: "fresh-access" },
      },
    );
  });
});
