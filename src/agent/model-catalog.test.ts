import { describe, expect, test } from "bun:test";
import { MODEL_PRESETS, type ModelPreset } from "@/agent-presets";
import { models } from "./model-catalog";

describe("browser-safe model preset export", () => {
  test("exposes the same curated catalog used by the CLI", () => {
    expect(MODEL_PRESETS).toBe(models);
    expect(MODEL_PRESETS.length).toBeGreaterThan(0);
  });

  test("includes presentation metadata and settings without claiming availability", () => {
    const preset: ModelPreset | undefined = MODEL_PRESETS.find(
      (entry) => entry.id === "gpt-5.6-luna-plus-pro-high",
    );

    expect(preset).toMatchObject({
      handle: "chatgpt-plus-pro/gpt-5.6-luna",
      label: "GPT-5.6 Luna (ChatGPT)",
      isFeatured: true,
      updateArgs: {
        reasoning_effort: "high",
      },
    });
    expect("available" in (preset ?? {})).toBe(false);
  });

  test("includes Kimi K3 direct and OpenRouter presets with Cloud-aligned limits", () => {
    const direct = MODEL_PRESETS.find((entry) => entry.id === "kimi-k3");
    const openrouter = MODEL_PRESETS.find(
      (entry) => entry.id === "kimi-k3-openrouter",
    );

    expect(direct).toMatchObject({
      handle: "moonshot/kimi-k3",
      label: "Kimi K3",
      updateArgs: {
        context_window: 1048576,
        max_output_tokens: 131072,
        reasoning_effort: "max",
      },
    });
    expect(openrouter).toMatchObject({
      handle: "openrouter/moonshotai/kimi-k3",
      label: "Kimi K3 (OpenRouter)",
      updateArgs: {
        context_window: 1048576,
        max_output_tokens: 131072,
        reasoning_effort: "max",
      },
    });
  });
});
