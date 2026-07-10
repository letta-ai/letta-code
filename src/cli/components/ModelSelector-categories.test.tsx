import { describe, expect, test } from "bun:test";

import {
  getModelCategories,
  includeUnknownBackendHandleInRecommended,
  toSelectorModelForHandle,
  usesBackendModelCatalog,
} from "@/cli/components/ModelSelector";

describe("getModelCategories", () => {
  test("uses the same hosted category order for free and paid tiers", () => {
    expect(getModelCategories("free", false, undefined, 0)).toEqual([
      "supported",
      "all",
      "byok",
      "byok-all",
    ]);

    expect(getModelCategories("pro", false, undefined, 0)).toEqual([
      "supported",
      "all",
      "byok",
      "byok-all",
    ]);
  });

  test("keeps self-hosted categories unchanged", () => {
    expect(getModelCategories("free", true, undefined, 0)).toEqual([
      "server-recommended",
      "server-all",
    ]);
  });

  test("uses server-style categories for local backend model catalogs", () => {
    expect(getModelCategories("pro", false, true, 0)).toEqual([
      "server-recommended",
      "server-all",
    ]);
  });

  test("prepends recents when recentModelCount >= 2", () => {
    expect(getModelCategories("free", false, undefined, 2)).toEqual([
      "recents",
      "supported",
      "all",
      "byok",
      "byok-all",
    ]);

    expect(getModelCategories("pro", false, undefined, 5)).toEqual([
      "recents",
      "supported",
      "all",
      "byok",
      "byok-all",
    ]);

    expect(getModelCategories("free", true, undefined, 3)).toEqual([
      "recents",
      "server-recommended",
      "server-all",
    ]);
  });

  test("does not prepend recents when recentModelCount < 2", () => {
    expect(getModelCategories("free", false, undefined, 0)).toEqual([
      "supported",
      "all",
      "byok",
      "byok-all",
    ]);

    expect(getModelCategories("free", false, undefined, 1)).toEqual([
      "supported",
      "all",
      "byok",
      "byok-all",
    ]);
  });

  test("treats local backend catalogs as backend model catalogs", () => {
    expect(usesBackendModelCatalog(false, true)).toBe(true);
    expect(usesBackendModelCatalog(true, false)).toBe(true);
    expect(usesBackendModelCatalog(false, false)).toBe(false);
  });

  test("keeps discovered local endpoint models in recommended backend catalogs", () => {
    expect(
      includeUnknownBackendHandleInRecommended("llama.cpp/local-model"),
    ).toBe(true);
    expect(
      includeUnknownBackendHandleInRecommended("llama-cpp/local-model"),
    ).toBe(true);
    expect(
      includeUnknownBackendHandleInRecommended("lmstudio/local-model"),
    ).toBe(true);
    expect(
      includeUnknownBackendHandleInRecommended("ollama/qwen2.5-coder:7b"),
    ).toBe(true);
    expect(
      includeUnknownBackendHandleInRecommended("ollama-cloud/gpt-oss:120b"),
    ).toBe(true);
  });

  test("does not promote unknown hosted backend handles to recommended", () => {
    expect(
      includeUnknownBackendHandleInRecommended("openai/not-in-registry"),
    ).toBe(false);
    expect(
      includeUnknownBackendHandleInRecommended("custom-provider/model"),
    ).toBe(false);
  });

  test("xAI SuperGrok catalog handles are not local-endpoint prefixes", () => {
    // Local OAuth catalogs still surface these via localModelCatalog in
    // ModelSelector recommended; the helper itself stays endpoint-specific.
    expect(includeUnknownBackendHandleInRecommended("xai/grok-4.3")).toBe(
      false,
    );
    expect(includeUnknownBackendHandleInRecommended("xai/grok-build-0.1")).toBe(
      false,
    );
  });
});

describe("toSelectorModelForHandle", () => {
  test("uses a display label without the local provider prefix", () => {
    expect(toSelectorModelForHandle("ollama/qwen2.5:7b")).toMatchObject({
      id: "ollama/qwen2.5:7b",
      handle: "ollama/qwen2.5:7b",
      label: "qwen2.5:7b",
    });
  });

  test("uses registry labels for known non-local handles", () => {
    expect(toSelectorModelForHandle("openai/gpt-5.5")).toMatchObject({
      label: "GPT-5.5",
    });
  });

  test("uses ChatGPT labels for local ChatGPT OAuth handles", () => {
    expect(toSelectorModelForHandle("openai-codex/gpt-5.5")).toMatchObject({
      id: "openai-codex/gpt-5.5",
      handle: "openai-codex/gpt-5.5",
      registryHandle: "chatgpt-plus-pro/gpt-5.5",
      label: "GPT-5.5 (ChatGPT)",
    });
  });
});
