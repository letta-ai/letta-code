import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { listLocalModels } from "@/backend/local/local-model-config";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";

describe("local model catalog", () => {
  afterEach(() => {
    clearRegisteredPiProviders();
  });

  test("projects configured Pi models with native display metadata", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-opencode-catalog-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "opencode",
        providerName: "opencode",
        apiKey: "test-key",
      });
      const fetchImpl = (async () =>
        new Response("not found", { status: 404 })) as unknown as typeof fetch;

      const entry = (
        await listLocalModels(storageDir, { fetch: fetchImpl })
      ).find((model) => model.handle === "opencode/kimi-k2.6");

      expect(entry).toMatchObject({
        display_name: "Kimi K2.6",
        handle: "opencode/kimi-k2.6",
        max_context_window: 262144,
        max_tokens: 65536,
        model_id: "kimi-k2.6",
        model_endpoint_type: "opencode",
        name: "Kimi K2.6",
        provider_type: "opencode",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("uses registered model metadata instead of endpoint heuristics", async () => {
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
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-registered-provider-catalog-"),
    );
    try {
      await createOrUpdateLocalProvider({
        providerType: "lmstudio",
        providerName: "lc-lmstudio",
        apiKey: "not-needed",
        baseURL: "http://127.0.0.1:1234/v1",
        storageDir,
      });
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({ data: [{ id: "heuristic-only-model" }] }),
          { headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch;

      const models = await listLocalModels(storageDir, { fetch: fetchImpl });

      expect(models).toContainEqual(
        expect.objectContaining({
          display_name: "Gemma 4 VLM",
          handle: "lmstudio/gemma-4-26B-A4B-it-oQ6",
          max_context_window: 256000,
          max_tokens: 8192,
          model_id: "gemma-4-26B-A4B-it-oQ6",
          model_endpoint_type: "lmstudio",
          provider_type: "lmstudio",
          reasoning_levels: ["off", "minimal", "low", "medium", "high"],
        }),
      );
      expect(models.map((model) => model.handle)).not.toContain(
        "lmstudio/heuristic-only-model",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
