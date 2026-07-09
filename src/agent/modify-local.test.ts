import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { configureBackendMode, getBackend } from "@/backend/backend";
import { createOrUpdateLocalProvider } from "@/backend/local";
import { LOCAL_BACKEND_DIR_ENV } from "@/backend/local/paths";
import { clearAvailableModelsCache } from "./available-models";
import {
  __modifyTestUtils,
  updateAgentLLMConfig,
  updateConversationLLMConfig,
} from "./modify";

async function withLocalBackendStorage<T>(
  storageDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const previousStorageDir = process.env[LOCAL_BACKEND_DIR_ENV];
  try {
    process.env[LOCAL_BACKEND_DIR_ENV] = storageDir;
    configureBackendMode("local");
    return await run();
  } finally {
    configureBackendMode("api");
    clearAvailableModelsCache();
    if (previousStorageDir === undefined) {
      delete process.env[LOCAL_BACKEND_DIR_ENV];
    } else {
      process.env[LOCAL_BACKEND_DIR_ENV] = previousStorageDir;
    }
  }
}

describe("local model updates", () => {
  test("builds direct xAI model settings for xAI handles", () => {
    expect(
      __modifyTestUtils.buildModelSettings("xai/grok-4.5", {
        context_window: 500000,
        max_output_tokens: 16384,
        parallel_tool_calls: true,
      }),
    ).toMatchObject({
      provider_type: "xai",
      parallel_tool_calls: true,
      max_output_tokens: 16384,
    });
  });

  afterEach(() => {
    configureBackendMode("api");
    clearAvailableModelsCache();
  });

  test("uses pi catalog token settings instead of static Letta model presets", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-model-update-pi-catalog-"),
    );
    try {
      await createOrUpdateLocalProvider({
        providerType: "openrouter",
        providerName: "lc-openrouter",
        apiKey: "dummy",
        storageDir,
      });

      await withLocalBackendStorage(storageDir, async () => {
        const backend = getBackend();
        const agent = await backend.createAgent({
          name: "Local",
          model: "openrouter/deepseek/deepseek-v4-pro",
          model_settings: {
            provider_type: "openrouter",
            max_output_tokens: 384000,
          },
          max_tokens: 384000,
          context_window_limit: 1048576,
        } as never);
        const conversation = await backend.createConversation({
          agent_id: agent.id,
        } as never);

        const updatedConversation = await updateConversationLLMConfig(
          conversation.id,
          "openrouter/moonshotai/kimi-k2.6",
          {
            context_window: 200000,
            max_output_tokens: 64000,
            parallel_tool_calls: true,
          },
        );

        const kimi = getModel("openrouter", "moonshotai/kimi-k2.6");
        const conversationModelSettings = updatedConversation.model_settings as
          | Record<string, unknown>
          | undefined;
        expect(conversationModelSettings?.context_window_limit).toBe(
          kimi?.contextWindow,
        );
        expect(conversationModelSettings?.max_tokens).toBe(kimi?.maxTokens);
        expect(conversationModelSettings?.max_output_tokens).toBeUndefined();

        const customizedConversation = await backend.updateConversation(
          conversation.id,
          {
            model: "openrouter/moonshotai/kimi-k2.6",
            model_settings: {
              provider_type: "openrouter",
              context_window_limit: 12345,
              max_tokens: 1234,
              parallel_tool_calls: false,
            },
          } as never,
        );
        const customizedConversationModelSettings =
          customizedConversation.model_settings as
            | Record<string, unknown>
            | undefined;
        expect(customizedConversationModelSettings?.context_window_limit).toBe(
          12345,
        );
        expect(customizedConversationModelSettings?.max_tokens).toBe(1234);

        const updated = await updateAgentLLMConfig(
          agent.id,
          "openrouter/moonshotai/kimi-k2.6",
          {
            context_window: 200000,
            max_output_tokens: 64000,
            parallel_tool_calls: true,
          },
        );

        expect(updated.model).toBe("openrouter/moonshotai/kimi-k2.6");
        expect(updated.llm_config?.context_window).toBe(kimi?.contextWindow);
        expect(updated.llm_config?.max_tokens).toBe(kimi?.maxTokens);
        expect(updated.llm_config?.max_tokens).not.toBe(384000);
        expect(updated.llm_config?.max_tokens).not.toBe(64000);
        expect(
          (updated.model_settings as Record<string, unknown>).max_output_tokens,
        ).toBeUndefined();
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves Fable xhigh as a distinct Anthropic effort", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-fable-effort-"));
    try {
      await createOrUpdateLocalProvider({
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "dummy",
        storageDir,
      });

      await withLocalBackendStorage(storageDir, async () => {
        const backend = getBackend();
        const agent = await backend.createAgent({
          name: "Local Fable",
          model: "anthropic/claude-fable-5",
          model_settings: {
            provider_type: "anthropic",
            effort: "high",
          },
          max_tokens: 128000,
          context_window_limit: 1000000,
        } as never);

        const updated = await updateAgentLLMConfig(
          agent.id,
          "anthropic/claude-fable-5",
          {
            context_window: 1000000,
            max_output_tokens: 128000,
            enable_reasoner: true,
            reasoning_effort: "xhigh",
            parallel_tool_calls: true,
          },
        );

        expect(updated.model_settings).toMatchObject({
          provider_type: "anthropic",
          effort: "xhigh",
        });
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
