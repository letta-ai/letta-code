import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isOpenAIModel } from "../../tools/manager";
import { deriveToolsetFromModel } from "../../tools/toolset";

describe("isOpenAIModel", () => {
  test("detects openai handles", () => {
    expect(isOpenAIModel("openai/gpt-5.2-codex")).toBe(true);
  });

  test("detects chatgpt-plus-pro handles", () => {
    expect(isOpenAIModel("chatgpt-plus-pro/gpt-5.3-codex")).toBe(true);
  });

  test("detects chatgpt_oauth handles", () => {
    expect(isOpenAIModel("chatgpt_oauth/gpt-5.3-codex")).toBe(true);
  });

  test("detects chatgpt-plus-pro model ids via models.json metadata", () => {
    expect(isOpenAIModel("gpt-5.3-codex-plus-pro-high")).toBe(true);
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
    expect(deriveToolsetFromModel("chatgpt_oauth/gpt-5.3-codex")).toBe("codex");
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
      new URL("../../tools/toolset.ts", import.meta.url),
    );
    const source = readFileSync(toolsetPath, "utf-8");

    expect(source).not.toContain("const CODEX_TOOLS = OPENAI_PASCAL_TOOLS");
    expect(source).toContain("loadSpecificTools([...OPENAI_PASCAL_TOOLS])");
  });
});
