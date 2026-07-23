import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
} from "@/agent/available-models";
import { models } from "@/agent/model";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";
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
    ] as never;
  }
}

describe("listener native model selection", () => {
  beforeEach(installRuntimeModelCatalogFixture);
  afterEach(() => {
    clearRuntimeModelCatalogFixture();
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
