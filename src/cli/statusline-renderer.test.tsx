import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import {
  DEFAULT_STATUSLINE_RENDERER_ID,
  getBuiltinStatuslineRenderer,
  getBuiltinStatuslineRenderers,
} from "@/cli/display/statusline/registry";
import { renderCustomStatusline } from "@/cli/display/statusline/renderers/Custom";
import { buildLegacyStatuslineParts } from "@/cli/display/statusline/renderers/Legacy";

describe("statusline renderers", () => {
  test("default renderer is legacy", () => {
    expect(DEFAULT_STATUSLINE_RENDERER_ID).toBe("legacy");
    expect(getBuiltinStatuslineRenderer(undefined).id).toBe("legacy");
    expect(getBuiltinStatuslineRenderer("missing").id).toBe("legacy");
  });

  test("registry exposes legacy and custom renderers", () => {
    expect(
      getBuiltinStatuslineRenderers().map((renderer) => renderer.id),
    ).toEqual(["legacy", "custom"]);
  });

  test("custom renderer is an empty placeholder", () => {
    expect(renderCustomStatusline()).toBeNull();
  });

  test("legacy renderer preserves the detailed model label", () => {
    const output = buildLegacyStatuslineParts({
      agentName: "Letta Code",
      currentModel: "GPT-5.5 (ChatGPT)",
      currentModelProvider: "chatgpt-plus-pro",
      currentReasoningEffort: "high",
      goalStatusText: null,
      hasTemporaryModelOverride: false,
      isByokProvider: false,
      isLocalBackend: true,
      isOpenAICodexProvider: false,
      rightColumnWidth: 80,
    });

    expect(stripAnsi(String(output.right)).trim()).toBe(
      "Letta Code [GPT-5.5 (ChatGPT) (high)] · local",
    );
  });

  test("legacy renderer suppresses reasoning for the no-model placeholder", () => {
    const output = buildLegacyStatuslineParts({
      agentName: "Letta Code",
      currentModel: "No model selected",
      currentModelProvider: "chatgpt-plus-pro",
      currentReasoningEffort: "high",
      goalStatusText: null,
      hasTemporaryModelOverride: false,
      isByokProvider: false,
      isLocalBackend: true,
      isOpenAICodexProvider: false,
      rightColumnWidth: 80,
    });

    expect(stripAnsi(String(output.right)).trim()).toBe(
      "Letta Code [No model selected] · local",
    );
  });
});
