import { describe, expect, test } from "bun:test";

import {
  getModelCategories,
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

  test("uses ChatGPT labels for newer ChatGPT OAuth handles", () => {
    expect(
      toSelectorModelForHandle("openai-codex/gpt-5.3-codex-spark"),
    ).toMatchObject({
      id: "openai-codex/gpt-5.3-codex-spark",
      handle: "openai-codex/gpt-5.3-codex-spark",
      registryHandle: "chatgpt-plus-pro/gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark (ChatGPT)",
    });

    expect(toSelectorModelForHandle("openai-codex/gpt-5.4-pro")).toMatchObject({
      id: "openai-codex/gpt-5.4-pro",
      handle: "openai-codex/gpt-5.4-pro",
      registryHandle: "chatgpt-plus-pro/gpt-5.4-pro",
      label: "GPT-5.4 Pro (ChatGPT)",
    });
  });
});
