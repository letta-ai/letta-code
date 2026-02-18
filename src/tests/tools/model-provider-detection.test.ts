import { describe, expect, test } from "bun:test";
import { isOpenAIModel } from "../../tools/manager";

describe("isOpenAIModel", () => {
  test("detects openai handles", () => {
    expect(isOpenAIModel("openai/gpt-5.2-codex")).toBe(true);
  });

  test("detects chatgpt-plus-pro handles", () => {
    expect(isOpenAIModel("chatgpt-plus-pro/gpt-5.3-codex")).toBe(true);
  });

  test("detects chatgpt-plus-pro model ids via models.json metadata", () => {
    expect(isOpenAIModel("gpt-5.3-codex-plus-pro-high")).toBe(true);
  });

  test("does not detect anthropic handles", () => {
    expect(isOpenAIModel("anthropic/claude-sonnet-4-6")).toBe(false);
  });
});
