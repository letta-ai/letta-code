import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveZaiConnection } from "@/backend/dev/pi-model-factory";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";

const CODING_ENDPOINT = "https://api.z.ai/api/coding/paas/v4";
const PAY_AS_YOU_GO_ENDPOINT = "https://api.z.ai/api/paas/v4";

describe("resolveZaiConnection coding-plan endpoint routing", () => {
  test("reuses the lone zai key on the published coding endpoint", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "zai-conn-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "zai",
        providerName: "lc-zai",
        apiKey: "coding-plan-key",
        timeout: false,
      });
      expect(
        resolveZaiConnection({
          storageDir,
          preferredProviderType: "zai",
          publishedBaseUrl: CODING_ENDPOINT,
        }),
      ).toMatchObject({
        apiKey: "coding-plan-key",
        baseURL: CODING_ENDPOINT,
        providerName: "zai-coding",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("keeps a stored custom base URL on the zai record", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "zai-conn-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "zai",
        providerName: "lc-zai",
        apiKey: "proxy-key",
        baseURL: "https://proxy.example.com/v1",
        timeout: false,
      });
      expect(
        resolveZaiConnection({
          storageDir,
          preferredProviderType: "zai",
          publishedBaseUrl: CODING_ENDPOINT,
        }),
      ).toMatchObject({
        apiKey: "proxy-key",
        baseURL: "https://proxy.example.com/v1",
        providerName: "zai",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("keeps the regular connection when a zai_coding record exists", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "zai-conn-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "zai",
        providerName: "lc-zai",
        apiKey: "regular-key",
        timeout: false,
      });
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "zai_coding",
        providerName: "lc-zai-coding",
        apiKey: "coding-key",
        timeout: false,
      });
      expect(
        resolveZaiConnection({
          storageDir,
          preferredProviderType: "zai",
          publishedBaseUrl: CODING_ENDPOINT,
        }),
      ).toMatchObject({
        apiKey: "regular-key",
        baseURL: PAY_AS_YOU_GO_ENDPOINT,
        providerName: "zai",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("treats a stored pay-as-you-go default URL like no base URL", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "zai-conn-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "zai",
        providerName: "lc-zai",
        apiKey: "coding-plan-key",
        baseURL: "https://api.z.ai/api/paas/v4",
        timeout: false,
      });
      expect(
        resolveZaiConnection({
          storageDir,
          preferredProviderType: "zai",
          publishedBaseUrl: CODING_ENDPOINT,
        }),
      ).toMatchObject({
        apiKey: "coding-plan-key",
        baseURL: CODING_ENDPOINT,
        providerName: "zai-coding",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("keeps current behavior without a published endpoint", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "zai-conn-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "zai",
        providerName: "lc-zai",
        apiKey: "regular-key",
        timeout: false,
      });
      expect(
        resolveZaiConnection({
          storageDir,
          preferredProviderType: "zai",
        }),
      ).toMatchObject({
        apiKey: "regular-key",
        baseURL: PAY_AS_YOU_GO_ENDPOINT,
        providerName: "zai",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("ignores non-coding published endpoints", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "zai-conn-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "zai",
        providerName: "lc-zai",
        apiKey: "regular-key",
        timeout: false,
      });
      expect(
        resolveZaiConnection({
          storageDir,
          preferredProviderType: "zai",
          publishedBaseUrl: "https://other.example.com/v1",
        }),
      ).toMatchObject({
        apiKey: "regular-key",
        baseURL: PAY_AS_YOU_GO_ENDPOINT,
        providerName: "zai",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
