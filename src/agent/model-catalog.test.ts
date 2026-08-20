import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getDefaultModel,
  models,
  resolveCatalogModel,
  resolveModel,
} from "@/agent/model-catalog";
import * as agentPresets from "@/agent-presets";

afterEach(() => {
  models.splice(0, models.length);
});

describe("runtime model catalog", () => {
  test("exposes a stable live array for runtime catalog sources", () => {
    const reference = models;
    models.push({
      id: "runtime-model",
      handle: "provider/runtime-model",
      label: "Runtime Model",
      description: "",
    });
    expect(reference[0]?.id).toBe("runtime-model");
  });

  test("keeps managed Auto aliases available before cloud hydration", () => {
    expect(resolveModel("auto")).toBe("letta/auto");
    expect(resolveModel("auto-chat")).toBe("letta/auto-chat");
    expect(getDefaultModel()).toBe("letta/auto");
  });

  test("resolves unique local pi-ai model IDs", () => {
    models.push({
      id: "claude-sonnet-4-6-medium",
      handle: "anthropic/claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      description: "",
    });
    expect(resolveModel("claude-sonnet-4-6")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });

  test("resolves established Anthropic CLI aliases from runtime entries", () => {
    models.push(
      {
        id: "claude-sonnet-4-6-low",
        handle: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "",
        updateArgs: { context_window: 200000 },
      },
      {
        id: "claude-haiku-4-5",
        handle: "anthropic/claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        description: "",
      },
    );

    expect(resolveModel("sonnet-4.6-low")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveCatalogModel("sonnet-4.6-low")?.updateArgs).toMatchObject({
      context_window: 200000,
      reasoning_effort: "low",
      enable_reasoner: true,
    });
    expect(resolveModel("haiku")).toBe("anthropic/claude-haiku-4-5");
  });

  test("does not ship a static catalog or export model presets", () => {
    expect("MODEL_PRESETS" in agentPresets).toBe(false);
    expect(existsSync(join(import.meta.dir, "..", "models.json"))).toBe(false);
  });

  test("does not guess ambiguous local model IDs", () => {
    models.push(
      {
        id: "provider-a/shared",
        handle: "provider-a/shared",
        label: "Shared A",
        description: "",
      },
      {
        id: "provider-b/shared",
        handle: "provider-b/shared",
        label: "Shared B",
        description: "",
      },
    );
    expect(resolveModel("shared")).toBeNull();
  });
});
