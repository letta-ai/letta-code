import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
} from "@/agent/available-models";
import { models } from "@/agent/model";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  buildListModelsResponse,
  resolveModelForUpdate,
} from "./model-toolset";

class NativeCatalogBackend extends FakeHeadlessBackend {
  override async listModels(): ReturnType<Backend["listModels"]> {
    return [
      {
        handle: "opencode/deepseek-v4-flash-free",
        display_name: "DeepSeek V4 Flash Free",
        max_context_window: 200000,
        max_tokens: 128000,
        provider_type: "opencode",
      },
      {
        handle: "google/gemini-3.5-flash",
        display_name: "Gemini 3.5 Flash",
        max_context_window: 1000000,
        max_tokens: 65536,
        provider_type: "google",
      },
      {
        handle: "proxy/claude-opus-4-6",
        display_name: "Claude Opus 4.6",
        provider_type: "openai",
        provider_category: "byok",
        model_endpoint: "https://proxy.example.com/openai/v1",
      },
      {
        handle: "lc-openai/gpt-5.4",
        display_name: "GPT-5.4",
        provider_type: "openai",
        provider_category: "byok",
        model_endpoint: "https://api.openai.com/v1",
      },
      {
        handle: "chatgpt-jin/gpt-5.6-sol-fast",
        display_name: "GPT-5.6 Sol Fast",
        provider_type: "chatgpt_oauth",
        provider_category: "byok",
      },
    ] as never;
  }
}

describe("listener native model selection", () => {
  afterEach(() => {
    clearAvailableModelsCache();
    __testSetBackend(null);
  });

  test("resolves a backend-native list_models id from the cached catalog", async () => {
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();

    expect(
      resolveModelForUpdate({
        model_id: "opencode/deepseek-v4-flash-free",
      }),
    ).toEqual({
      id: "opencode/deepseek-v4-flash-free",
      handle: "opencode/deepseek-v4-flash-free",
      label: "DeepSeek V4 Flash Free",
      updateArgs: undefined,
    });
  });

  test("includes backend-native rows in the full list_models response", async () => {
    __testSetBackend(new NativeCatalogBackend());

    const response = await buildListModelsResponse("models-1");

    expect(response.available_handles).toContain(
      "opencode/deepseek-v4-flash-free",
    );
    expect(response.entries).toContainEqual({
      id: "opencode/deepseek-v4-flash-free",
      handle: "opencode/deepseek-v4-flash-free",
      label: "DeepSeek V4 Flash Free",
      description: "",
    });
    expect(response.entries).toContainEqual({
      id: "proxy/claude-opus-4-6",
      handle: "proxy/claude-opus-4-6",
      label: "Claude Opus 4.6",
      description: "",
      updateArgs: {
        provider_type: "openai",
        openai_compatible_proxy: true,
      },
    });
    expect(
      response.entries.find((entry) => entry.handle === "lc-openai/gpt-5.4")
        ?.updateArgs,
    ).toBeUndefined();
  });

  test("applies explicit proxy effort from a device update without leaking it to direct OpenAI", async () => {
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();

    expect(
      resolveModelForUpdate({
        model_id: "proxy/claude-opus-4-6",
        reasoning_effort: null,
      })?.updateArgs,
    ).toEqual({
      provider_type: "openai",
      openai_compatible_proxy: true,
      reasoning_effort: null,
    });
    expect(
      resolveModelForUpdate({
        model_id: "lc-openai/gpt-5.4",
        reasoning_effort: null,
      })?.updateArgs,
    ).toBeUndefined();
  });

  test("preserves ChatGPT OAuth provider identity for native Fast aliases", async () => {
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();

    expect(
      resolveModelForUpdate({
        model_id: "chatgpt-jin/gpt-5.6-sol-fast",
      }),
    ).toEqual({
      id: "chatgpt-jin/gpt-5.6-sol-fast",
      handle: "chatgpt-jin/gpt-5.6-sol-fast",
      label: "GPT-5.6 Sol Fast",
      updateArgs: { provider_type: "chatgpt_oauth" },
    });
  });

  test("preserves a native handle id if the availability cache was cleared", () => {
    expect(
      resolveModelForUpdate({
        model_id: "opencode/deepseek-v4-flash-free",
      }),
    ).toEqual({
      id: "opencode/deepseek-v4-flash-free",
      handle: "opencode/deepseek-v4-flash-free",
      label: "opencode/deepseek-v4-flash-free",
      updateArgs: undefined,
    });
  });

  test("applies a curated preset to the equivalent native Pi handle", async () => {
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();
    const preset = models.find(
      (model) => model.handle === "google_ai/gemini-3.5-flash",
    );
    expect(preset).toBeDefined();

    const resolved = resolveModelForUpdate({ model_id: preset?.id });

    expect(resolved).toMatchObject({
      id: preset?.id,
      handle: "google/gemini-3.5-flash",
      label: preset?.label,
      updateArgs: { provider_type: "google" },
    });
  });
});
