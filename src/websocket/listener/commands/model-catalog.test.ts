import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AvailableModel } from "@/agent/available-models";
import { models } from "@/agent/model";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";
import {
  buildListModelsEntries,
  findAvailableModelForPreset,
} from "./model-catalog";

beforeEach(installRuntimeModelCatalogFixture);
afterEach(clearRuntimeModelCatalogFixture);

describe("listener model catalog", () => {
  test("preserves the ordered runtime preset overlay", () => {
    const entries = buildListModelsEntries();

    expect(entries).toHaveLength(models.length);
    expect(entries[0]).toMatchObject({
      id: models[0]?.id,
      handle: models[0]?.handle,
      label: models[0]?.label,
      description: models[0]?.description,
    });
  });

  test("appends backend-native models absent from the runtime catalog", () => {
    const nativeModel: AvailableModel = {
      handle: "opencode/deepseek-v4-flash-free",
      label: "DeepSeek V4 Flash Free",
      maxContextWindow: 200000,
      maxOutputTokens: 128000,
      providerType: "opencode",
    };

    const entries = buildListModelsEntries([nativeModel]);

    expect(entries.at(-1)).toEqual({
      id: nativeModel.handle,
      handle: nativeModel.handle,
      label: nativeModel.label,
      description: "",
    });
  });

  test("keeps curated variants instead of adding a duplicate native row", () => {
    const variantsByHandle = new Map<string, (typeof models)[number][]>();
    for (const model of models) {
      const variants = variantsByHandle.get(model.handle) ?? [];
      variants.push(model);
      variantsByHandle.set(model.handle, variants);
    }
    const variants = [...variantsByHandle.values()].find(
      (entries) => entries.length > 1,
    );
    expect(variants).toBeDefined();
    const handle = variants?.[0]?.handle ?? "";

    const entries = buildListModelsEntries([{ handle, label: "Native label" }]);

    expect(entries.filter((entry) => entry.handle === handle)).toHaveLength(
      variants?.length ?? 0,
    );
    expect(
      entries.some(
        (entry) => entry.id === handle && entry.label === "Native label",
      ),
    ).toBe(false);
  });

  test("projects curated presets onto an equivalent native Pi handle", () => {
    const presetHandle = "google_ai/gemini-3.5-flash";
    const nativeModel: AvailableModel = {
      handle: "google/gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      providerType: "google",
    };
    const presets = models.filter((model) => model.handle === presetHandle);
    expect(presets.length).toBeGreaterThan(0);

    const entries = buildListModelsEntries([nativeModel]);
    const projected = entries.filter(
      (entry) => entry.handle === nativeModel.handle,
    );

    expect(projected.map((entry) => entry.id)).toEqual(
      presets.map((preset) => preset.id),
    );
    expect(projected.map((entry) => entry.updateArgs)).toEqual(
      presets.map((preset) => preset.updateArgs),
    );
    expect(findAvailableModelForPreset(presetHandle, [nativeModel])).toEqual(
      nativeModel,
    );
    const vertexModel: AvailableModel = {
      handle: "google-vertex/gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro",
    };
    expect(
      findAvailableModelForPreset("google_vertex/gemini-3.1-pro-preview", [
        vertexModel,
      ]),
    ).toEqual(vertexModel);
  });

  test("does not apply another provider's presets to the same model name", () => {
    const nativeModel: AvailableModel = {
      handle: "opencode/claude-fable-5",
      label: "Claude Fable 5 (OpenCode)",
      providerType: "opencode",
    };

    const entries = buildListModelsEntries([nativeModel]);

    expect(
      entries.filter((entry) => entry.handle === nativeModel.handle),
    ).toEqual([
      {
        id: nativeModel.handle,
        handle: nativeModel.handle,
        label: nativeModel.label,
        description: "",
      },
    ]);
  });
});
