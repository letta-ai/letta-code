import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";
import { isOpenAIModel } from "@/tools/manager";
import { deriveToolsetFromModel } from "@/tools/toolset";

beforeEach(installRuntimeModelCatalogFixture);
afterEach(clearRuntimeModelCatalogFixture);

describe("isOpenAIModel", () => {
  test("detects openai handles", () => {
    expect(isOpenAIModel("openai/gpt-5.2-codex")).toBe(true);
  });

  test("detects chatgpt-plus-pro handles", () => {
    expect(isOpenAIModel("chatgpt-plus-pro/gpt-5.5")).toBe(true);
  });

  test("detects chatgpt_oauth handles", () => {
    expect(isOpenAIModel("chatgpt_oauth/gpt-5.5")).toBe(true);
  });

  test("detects local ChatGPT OAuth handles", () => {
    expect(isOpenAIModel("openai-codex/gpt-5.5")).toBe(true);
  });

  test("detects chatgpt-plus-pro model ids via runtime metadata", () => {
    expect(isOpenAIModel("gpt-5.5-plus-pro-high")).toBe(true);
  });

  test("does not detect anthropic handles", () => {
    expect(isOpenAIModel("anthropic/claude-sonnet-4-6")).toBe(false);
  });

  test("does not detect auto model ids/handles", () => {
    expect(isOpenAIModel("auto")).toBe(false);
    expect(isOpenAIModel("letta/auto")).toBe(false);
    expect(isOpenAIModel("auto-fast")).toBe(false);
    expect(isOpenAIModel("letta/auto-fast")).toBe(false);
  });
});

describe("deriveToolsetFromModel", () => {
  test("maps chatgpt_oauth handles to codex toolset", () => {
    expect(deriveToolsetFromModel("chatgpt_oauth/gpt-5.5")).toBe("codex");
  });

  test("maps local ChatGPT OAuth handles to codex toolset", () => {
    expect(deriveToolsetFromModel("openai-codex/gpt-5.5")).toBe("codex");
  });

  test("maps custom ChatGPT OAuth aliases to codex toolset via provider type", () => {
    expect(
      deriveToolsetFromModel("chatgpt-work/gpt-5.5", "chatgpt_oauth"),
    ).toBe("codex");
  });

  test("maps Gemini models to default (anthropic) toolset", () => {
    expect(deriveToolsetFromModel("google_ai/gemini-2.5-pro")).toBe("default");
    expect(deriveToolsetFromModel("gemini-pro")).toBe("default");
  });

  test("maps MiniMax M3 to default (anthropic) toolset", () => {
    expect(isOpenAIModel("minimax-m3")).toBe(false);
    expect(deriveToolsetFromModel("minimax-m3")).toBe("default");
    expect(deriveToolsetFromModel("minimax/MiniMax-M3")).toBe("default");
  });

  test("maps auto models to default (anthropic) toolset", () => {
    expect(deriveToolsetFromModel("auto")).toBe("default");
    expect(deriveToolsetFromModel("letta/auto")).toBe("default");
    expect(deriveToolsetFromModel("auto-fast")).toBe("default");
    expect(deriveToolsetFromModel("letta/auto-fast")).toBe("default");
  });
});

describe("toolset initialization safety", () => {
  test("avoids top-level toolset aliases that can trigger circular-import TDZ", () => {
    const toolsetPath = fileURLToPath(
      new URL("../tools/toolset.ts", import.meta.url),
    );
    const source = readFileSync(toolsetPath, "utf-8");

    expect(source).not.toContain("const CODEX_TOOLS = OPENAI_PASCAL_TOOLS");
    expect(source).toContain("loadSpecificTools([...OPENAI_PASCAL_TOOLS])");
  });
});
