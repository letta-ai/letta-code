import { describe, expect, test } from "bun:test";
import { models } from "@/agent/model";
import {
  filterModelsByAvailabilityForSelector,
  preferredStaticModelForHandle,
} from "@/cli/components/ModelSelector";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

setupRuntimeModelCatalogFixture();

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

  test("includes the Kimi K3 preset only when the API catalog exposes its handle", () => {
    const result = filterModelsByAvailabilityForSelector(
      models,
      new Set(["moonshot/kimi-k3"]),
      [],
    );

    expect(result.map((m) => m.handle)).toEqual(["moonshot/kimi-k3"]);
    expect(result.map((m) => m.updateArgs?.reasoning_effort)).toEqual([
      undefined,
    ]);
  });

  test("keeps direct and OpenRouter Kimi K3 rows on distinct selector keys", () => {
    models.push({
      id: "kimi-k3-openrouter",
      handle: "moonshotai/kimi-k3",
      label: "Kimi K3",
      description: "Moonshot AI's Kimi K3 model (high reasoning)",
      updateArgs: {
        context_window: 1048576,
        reasoning_effort: "high",
      },
    });
    const direct = models.find((model) => model.handle === "moonshot/kimi-k3");
    const openRouter = models.find(
      (model) => model.handle === "moonshotai/kimi-k3",
    );
    if (!direct || !openRouter) {
      throw new Error("expected both Kimi K3 catalog handles");
    }

    const rows = [direct, openRouter].map(
      (model) =>
        preferredStaticModelForHandle(
          models,
          model.handle,
          model.updateArgs?.context_window as number,
        ) ?? model,
    );

    expect(rows.map((model) => model.id)).toEqual([
      "kimi-k3",
      "kimi-k3-openrouter",
    ]);
    expect(new Set(rows.map((model) => model.id)).size).toBe(rows.length);
  });
});
