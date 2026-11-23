import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLocalModels } from "@/backend/local/local-model-config";
import {
  createOrUpdateLocalProvider,
  localOAuthAuthFromCredentials,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { resolvePiModelForAgent } from "./pi-model-factory";
import { LocalPiModelsRuntime } from "./pi-models-runtime";

setupRuntimeModelCatalogFixture();

test("local catalog handles resolve to the matching provider routes", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-model-catalog-"));
  const requestedHosts = new Set<string>();
  const offlineFetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      requestedHosts.add(new URL(String(input)).hostname);
      throw new Error("Unexpected provider request");
    },
    { preconnect: fetch.preconnect },
  );
  try {
    for (const provider of ["google", "openai", "anthropic", "openrouter"]) {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: provider,
        providerName: provider,
        apiKey: "fake-key",
      });
    }
    setLocalOAuthProvider({
      storageDir,
      providerName: "chatgpt-plus-pro",
      providerType: "chatgpt_oauth",
      auth: localOAuthAuthFromCredentials({
        access: "fake-access",
        refresh: "fake-refresh",
        expires: Date.now() + 3_600_000,
      }),
    });

    const modelsRuntime = new LocalPiModelsRuntime({
      storageDir,
      fetchImpl: offlineFetch,
    });
    const models = await listLocalModels(storageDir, { modelsRuntime });

    for (const [provider, api, ids] of [
      [
        "google",
        "google-generative-ai",
        ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon"],
      ],
      ["openai", "openai-responses", ["gpt-6.2-astra", "gpt-6.2-sol"]],
      [
        "openai-codex",
        "openai-codex-responses",
        ["gpt-6.2-astra", "gpt-6.2-sol"],
      ],
      ["anthropic", "anthropic-messages", ["claude-fable-5-2"]],
      [
        "openrouter",
        "openai-completions",
        ["qwen/qwen4-max", "thinkingmachines/inkling-2-small"],
      ],
    ] as const) {
      for (const id of ids) {
        const handle = `${provider}/${id}`;
        const entry = models.find((model) => model.handle === handle);
        expect(entry, handle).toBeDefined();
        const resolved = await resolvePiModelForAgent(
          handle,
          { provider_type: entry?.provider_type },
          { localProviderAuthStorageDir: storageDir, modelsRuntime },
        );
        expect(resolved.model).toMatchObject({ id, provider, api });
      }
    }
    expect(
      [...requestedHosts].filter(
        (host) => host !== "localhost" && host !== "127.0.0.1",
      ),
    ).toEqual([]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
