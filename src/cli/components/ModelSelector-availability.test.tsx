import { describe, expect, test } from "bun:test";
import { models } from "@/agent/model";
import { filterModelsByAvailabilityForSelector } from "@/cli/components/ModelSelector";

type StubModel = { handle: string; label: string };

const MODELS: StubModel[] = [
  { handle: "letta/auto", label: "Auto" },
  { handle: "letta/auto-fast", label: "Auto Fast" },
  { handle: "letta/glm", label: "GLM" },
  { handle: "anthropic/claude-sonnet-4-6", label: "Sonnet 4.6" },
];

describe("ModelSelector availability gating", () => {
  test("includes letta/auto when API availability includes it", () => {
    const availableHandles = new Set([
      "letta/auto",
      "anthropic/claude-sonnet-4-6",
    ]);

    const result = filterModelsByAvailabilityForSelector(
      MODELS,
      availableHandles,
      Array.from(availableHandles),
    );

    expect(result.map((m) => m.handle)).toContain("letta/auto");
  });

  test("excludes letta/auto when API availability does not include it", () => {
    const availableHandles = new Set(["anthropic/claude-sonnet-4-6"]);

    const result = filterModelsByAvailabilityForSelector(
      MODELS,
      availableHandles,
      Array.from(availableHandles),
    );

    expect(result.map((m) => m.handle)).not.toContain("letta/auto");
  });

  test("fallback mode hides API-gated Letta models unless explicitly present in allApiHandles", () => {
    const hiddenResult = filterModelsByAvailabilityForSelector(MODELS, null, [
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(hiddenResult.map((m) => m.handle)).not.toContain("letta/auto");
    expect(hiddenResult.map((m) => m.handle)).not.toContain("letta/glm");
    expect(hiddenResult.map((m) => m.handle)).toContain(
      "anthropic/claude-sonnet-4-6",
    );

    const shownResult = filterModelsByAvailabilityForSelector(MODELS, null, [
      "letta/auto",
      "letta/glm",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(shownResult.map((m) => m.handle)).toContain("letta/auto");
    expect(shownResult.map((m) => m.handle)).toContain("letta/glm");
  });

  test("includes Kimi K3 presets only when the API catalog exposes those handles", () => {
    const result = filterModelsByAvailabilityForSelector(
      models,
      new Set(["moonshot/kimi-k3", "openrouter/moonshotai/kimi-k3"]),
      [],
    );

    expect(result.map((m) => m.handle)).toEqual([
      "moonshot/kimi-k3",
      "openrouter/moonshotai/kimi-k3",
    ]);
    expect(result.map((m) => m.updateArgs?.reasoning_effort)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
