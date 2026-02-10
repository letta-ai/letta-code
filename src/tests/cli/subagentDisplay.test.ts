import { describe, expect, test } from "bun:test";
import { getSubagentModelDisplay } from "../../cli/helpers/subagentDisplay";

describe("getSubagentModelDisplay", () => {
  test("includes reasoning effort label when provided", () => {
    const display = getSubagentModelDisplay("openai/gpt-5.2", "xhigh");
    expect(display).toEqual({
      label: "GPT-5.2",
      isByokProvider: false,
      isOpenAICodexProvider: false,
      reasoningEffortLabel: "xhigh",
    });
  });

  test("includes minimal reasoning effort label", () => {
    const display = getSubagentModelDisplay("openai/gpt-5.2", "minimal");
    expect(display).toEqual({
      label: "GPT-5.2",
      isByokProvider: false,
      isOpenAICodexProvider: false,
      reasoningEffortLabel: "min",
    });
  });

  test("does not show unknown reasoning effort values", () => {
    const display = getSubagentModelDisplay("openai/gpt-5.2", "superhigh");
    expect(display).toEqual({
      label: "GPT-5.2",
      isByokProvider: false,
      isOpenAICodexProvider: false,
      reasoningEffortLabel: undefined,
    });
  });

  test("does not show none reasoning effort", () => {
    const display = getSubagentModelDisplay("openai/gpt-5.2", "none");
    expect(display).toEqual({
      label: "GPT-5.2",
      isByokProvider: false,
      isOpenAICodexProvider: false,
      reasoningEffortLabel: undefined,
    });
  });

  test("formats known model IDs using short labels", () => {
    const display = getSubagentModelDisplay("haiku", null);
    expect(display).toEqual({
      label: "Haiku 4.5",
      isByokProvider: false,
      isOpenAICodexProvider: false,
      reasoningEffortLabel: undefined,
    });
  });

  test("formats non-BYOK handles using short labels", () => {
    const display = getSubagentModelDisplay(
      "anthropic/claude-haiku-4-5-20251001",
      null,
    );
    expect(display).toEqual({
      label: "Haiku 4.5",
      isByokProvider: false,
      isOpenAICodexProvider: false,
      reasoningEffortLabel: undefined,
    });
  });

  test("marks lc-* handles as BYOK", () => {
    const display = getSubagentModelDisplay(
      "lc-anthropic/claude-haiku-4-5-20251001",
      null,
    );
    expect(display).toEqual({
      label: "claude-haiku-4-5-20251001",
      isByokProvider: true,
      isOpenAICodexProvider: false,
      reasoningEffortLabel: undefined,
    });
  });

  test("marks chatgpt-plus-pro handles as BYOK", () => {
    const display = getSubagentModelDisplay(
      "chatgpt-plus-pro/gpt-5.2-codex",
      null,
    );
    expect(display).toEqual({
      label: "GPT-5.2 Codex",
      isByokProvider: true,
      isOpenAICodexProvider: true,
      reasoningEffortLabel: undefined,
    });
  });
});
