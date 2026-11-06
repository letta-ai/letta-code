import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiModelForAgent } from "@/backend/dev/pi-model-factory";
import {
  clearRegisteredPiProviders,
  type PiProviderRegistration,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import { normalizeAgentRecord } from "@/backend/local/local-agent-record";
import { LocalBackend } from "@/backend/local/local-backend";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

setupRuntimeModelCatalogFixture();

describe("local provider resume", () => {
  afterEach(clearRegisteredPiProviders);

  test.each([
    { dynamic: false, conversationOverride: false },
    { dynamic: true, conversationOverride: false },
    { dynamic: false, conversationOverride: true },
    { dynamic: true, conversationOverride: true },
  ])(
    "resumes a saved provider model after mods load: %j",
    async ({ dynamic, conversationOverride }) => {
      const storageDir = await mkdtemp(join(tmpdir(), "local-mod-resume-"));
      const registration: PiProviderRegistration = {
        baseUrl: "http://localhost:8000/v1",
        apiKey: "not-needed",
        api: "openai-completions",
        models: [
          {
            id: "custom-model",
            name: "Custom Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 4096,
          },
        ],
      };
      try {
        registerPiProvider("custom-provider", registration);
        const backend = new LocalBackend({ storageDir, memfsEnabled: false });
        const agent = await backend.createAgent({
          name: "Local",
          model: "custom-provider/custom-model",
          model_settings: { provider_type: "openai" },
        });
        expect(agent.model).toBe("custom-provider/custom-model");
        const conversation = conversationOverride
          ? await backend.createConversation({
              agent_id: agent.id,
              model: "custom-provider/custom-model",
              model_settings: { provider_type: "openai" },
            })
          : undefined;

        clearRegisteredPiProviders();
        const restarted = new LocalBackend({ storageDir, memfsEnabled: false });
        const resumed = conversation
          ? await restarted.retrieveConversation(conversation.id)
          : await restarted.retrieveAgent(agent.id);
        registerPiProvider("custom-provider", {
          ...registration,
          ...(dynamic
            ? { models: [], listModels: () => registration.models ?? [] }
            : {}),
        });

        const resolved = await resolvePiModelForAgent(
          resumed.model ?? undefined,
          resumed.model_settings ?? {},
          { localProviderAuthStorageDir: storageDir },
        );
        expect(resumed.model).toBe("custom-provider/custom-model");
        expect(resolved).toMatchObject({
          provider: "custom-provider",
          model: { id: "custom-model" },
        });
      } finally {
        await rm(storageDir, { recursive: true, force: true });
      }
    },
  );

  test("still converts legacy provider-namespaced model names", () => {
    const record = normalizeAgentRecord(
      {
        id: "legacy-agent",
        llm_config: {
          model: "z-ai/glm-4.6:exacto",
          model_endpoint_type: "openrouter",
        },
      },
      "local/default",
    );
    expect(record?.model).toBe("openrouter/z-ai/glm-4.6:exacto");
  });
});
