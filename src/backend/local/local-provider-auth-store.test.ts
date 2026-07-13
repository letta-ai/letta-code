import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrUpdateLocalProvider,
  getLocalProviderRecordByName,
  setLocalOAuthProvider,
} from "./local-provider-auth-store";

describe("local OAuth provider storage", () => {
  const storageDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      storageDirs
        .splice(0)
        .map((storageDir) => rm(storageDir, { recursive: true, force: true })),
    );
  });

  test("preserves proxy routing when OAuth credentials refresh", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-oauth-routing-"));
    storageDirs.push(storageDir);
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "chatgpt_oauth",
      providerName: "chatgpt-work",
      apiKey: JSON.stringify({
        access_token: "old-access-token",
        id_token: "old-id-token",
        account_id: "account-123",
        expires_at: Date.now() + 60_000,
      }),
      baseURL: "https://proxy.example.test/backend-api",
      timeout: 30_000,
    });

    setLocalOAuthProvider({
      storageDir,
      providerName: "chatgpt-work",
      providerType: "chatgpt_oauth",
      auth: {
        type: "oauth",
        access: "refreshed-access-token",
        expires: Date.now() + 120_000,
      },
    });

    expect(
      getLocalProviderRecordByName("chatgpt-work", storageDir),
    ).toMatchObject({
      base_url: "https://proxy.example.test/backend-api",
      timeout: 30_000,
      auth: {
        type: "oauth",
        access: "refreshed-access-token",
      },
    });
  });

  test("rejects OAuth aliases that collide with another provider type", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-oauth-collision-"));
    storageDirs.push(storageDir);
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openai",
      providerName: "work",
      apiKey: "openai-key",
    });

    expect(() =>
      setLocalOAuthProvider({
        storageDir,
        providerName: "work",
        providerType: "anthropic",
        auth: {
          type: "oauth",
          access: "anthropic-token",
          expires: Date.now() + 60_000,
        },
      }),
    ).toThrow('Provider name "work" is already used by type "openai".');

    expect(() =>
      setLocalOAuthProvider({
        storageDir,
        providerName: "anthropic",
        providerType: "chatgpt_oauth",
        auth: {
          type: "oauth",
          access: "chatgpt-token",
          expires: Date.now() + 60_000,
        },
      }),
    ).toThrow('Provider name "anthropic" is reserved for type "anthropic".');

    expect(() =>
      setLocalOAuthProvider({
        storageDir,
        providerName: "work/account",
        providerType: "anthropic",
        auth: {
          type: "oauth",
          access: "anthropic-token",
          expires: Date.now() + 60_000,
        },
      }),
    ).toThrow(
      "OAuth provider name may only contain letters, numbers, dots, underscores, and hyphens.",
    );
  });
});
