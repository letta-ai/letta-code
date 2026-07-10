import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrUpdateLocalProvider,
  getLocalProviderRecordByName,
  localOAuthAuthFromCredentials,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";

describe("local provider auth store", () => {
  test("refuses implicit API-key to OAuth replacement", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-auth-conflict-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "xai",
        providerName: "xai",
        apiKey: "xai-api-key",
      });

      expect(() =>
        setLocalOAuthProvider({
          storageDir,
          providerName: "xai",
          providerType: "xai",
          auth: localOAuthAuthFromCredentials({
            access: "xai-oauth-access",
            refresh: "xai-oauth-refresh",
            expires: Date.now() + 60_000,
          }),
        }),
      ).toThrow(
        'Provider "xai" is already connected with an API key. Disconnect it before connecting OAuth credentials.',
      );

      const record = getLocalProviderRecordByName("xai", storageDir);
      expect(record?.auth).toEqual({ type: "api", key: "xai-api-key" });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("refuses implicit OAuth to API-key replacement", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-auth-conflict-"));
    try {
      setLocalOAuthProvider({
        storageDir,
        providerName: "xai",
        providerType: "xai",
        auth: localOAuthAuthFromCredentials({
          access: "xai-oauth-access",
          refresh: "xai-oauth-refresh",
          expires: Date.now() + 60_000,
        }),
      });

      await expect(
        createOrUpdateLocalProvider({
          storageDir,
          providerType: "xai",
          providerName: "xai",
          apiKey: "xai-api-key",
        }),
      ).rejects.toThrow(
        'Provider "xai" is already connected with OAuth credentials. Disconnect it before connecting an API key.',
      );

      const record = getLocalProviderRecordByName("xai", storageDir);
      expect(record?.auth.type).toBe("oauth");
      if (record?.auth.type !== "oauth") {
        throw new Error("Expected OAuth record");
      }
      expect(record.auth.access).toBe("xai-oauth-access");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
