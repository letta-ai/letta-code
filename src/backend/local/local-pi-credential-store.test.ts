import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(await store.list()).toContainEqual({
      providerId: "lc-anthropic",
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
