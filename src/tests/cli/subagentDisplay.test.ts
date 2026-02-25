import { describe, expect, test } from "bun:test";
import { getSubagentModelDisplay } from "../../cli/helpers/subagentDisplay";

describe("getSubagentModelDisplay", () => {
  test("formats known model IDs using short labels", () => {
    const display = getSubagentModelDisplay("haiku");
    expect(display).toEqual({
      label: "Haiku 4.5",
      isByokProvider: false,
      isOpenAICodexProvider: false,
    });
  });

  test("formats non-BYOK handles using short labels", () => {
    const display = getSubagentModelDisplay(
      "anthropic/claude-haiku-4-5",
    );
    expect(display).toEqual({
      label: "Haiku 4.5",
      isByokProvider: false,
      isOpenAICodexProvider: false,
    });
  });

  test("marks lc-* handles as BYOK", () => {
    const display = getSubagentModelDisplay(
      "lc-anthropic/claude-haiku-4-5",
    );
    expect(display).toEqual({
      label: "Haiku 4.5",
      isByokProvider: true,
      isOpenAICodexProvider: false,
    });
  });

  test("marks chatgpt-plus-pro handles as BYOK", () => {
    const display = getSubagentModelDisplay("chatgpt-plus-pro/gpt-5.2-codex");
    expect(display).toEqual({
      label: "GPT-5.2 Codex",
      isByokProvider: true,
      isOpenAICodexProvider: true,
    });
  });
});
