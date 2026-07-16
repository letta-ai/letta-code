import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiModelForAgent } from "@/backend/dev/pi-model-factory";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  listCatalogModelsForProvider,
  localModelHandle,
  PI_PROVIDER_SPECS,
} from "@/backend/dev/pi-provider-registry";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  localLlmConfigModelPatch,
  normalizeLocalModelHandle,
} from "@/backend/local/local-model-normalization";

function localConversationDir(
  storageDir: string,
  conversationId: string,
): string {
  return join(
    storageDir,
    "conversations",
    Buffer.from(`conversation:${conversationId}`).toString("base64url"),
  );
}

describe("local model normalization", () => {
  afterEach(() => {
    clearRegisteredPiProviders();
  });

  test("preserves Pi catalog handles over stale legacy OpenAI metadata", () => {
    const handle = "opencode/deepseek-v4-flash-free";

    expect(
      normalizeLocalModelHandle(
        handle,
        { provider_type: "openai" },
        { model_endpoint_type: "openai" },
      ),
    ).toBe(handle);
  });

  test("runs a stored native Pi handle despite stale provider metadata", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-opencode-handle-"));
    try {
      const handle = "opencode/deepseek-v4-flash-free";
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Local",
        model: handle,
        model_settings: { provider_type: "openai" },
      } as never);

      expect(agent.model).toBe(handle);
      const resolved = await resolvePiModelForAgent(
        agent.model ?? undefined,
        agent.model_settings ?? {},
        { localProviderAuthStorageDir: storageDir },
      );
      expect(resolved.provider).toBe("opencode");
      expect(resolved.model.id).toBe("deepseek-v4-flash-free");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves a representative handle for every built-in Pi provider", () => {
    for (const provider of PI_PROVIDER_SPECS) {
      const handle = provider.piProvider
        ? listCatalogModelsForProvider(provider.id)[0]
        : provider.createCustomModel
          ? localModelHandle(provider.id, "custom-model")
          : undefined;
      if (!handle) continue;

      expect(
        normalizeLocalModelHandle(handle, { provider_type: "openai" }),
      ).toBe(handle);
    }
  });

  test("preserves handles owned by registered provider mods", () => {
    registerPiProvider("custom-provider", {
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
    });

    expect(
      normalizeLocalModelHandle("custom-provider/custom-model", {
        provider_type: "openai",
      }),
    ).toBe("custom-provider/custom-model");
  });

  test("projects canonical provider metadata for local agents", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-anthropic-llm-config-"),
    );
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Local",
        model: "openai/claude-sonnet-4-6",
        model_settings: { provider_type: "openai" },
      } as never);

      expect(agent.model).toBe("anthropic/claude-sonnet-4-6");
      expect(agent.llm_config).toMatchObject({
        model: "claude-sonnet-4-6",
        model_endpoint_type: "anthropic",
      });
      expect(
        localLlmConfigModelPatch("lmstudio/local-model", {
          provider_type: "lmstudio_openai",
        }),
      ).toEqual({
        model: "local-model",
        model_endpoint_type: "lmstudio",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("normalizes unique bare model names before storing local agents", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-bare-anthropic-model-"),
    );
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Local",
        model: "claude-sonnet-4-6",
      } as never);

      expect(agent.model).toBe("anthropic/claude-sonnet-4-6");
      expect(agent.llm_config?.model_endpoint_type).toBe("anthropic");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("normalizes persisted stale OpenAI conversation overrides", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-stale-openai-conversation-"),
    );
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      const conversationPath = join(
        localConversationDir(storageDir, conversation.id),
        "conversation.json",
      );
      const persisted = JSON.parse(
        await readFile(conversationPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        conversationPath,
        `${JSON.stringify(
          {
            ...persisted,
            model: "openai/claude-sonnet-4-6",
            model_settings: { provider_type: "openai" },
          },
          null,
          2,
        )}\n`,
      );

      const reloadedBackend = new LocalBackend({
        storageDir,
        memfsEnabled: false,
      });
      const reloadedConversation = await reloadedBackend.retrieveConversation(
        conversation.id,
      );

      expect(reloadedConversation.model).toBe("anthropic/claude-sonnet-4-6");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
