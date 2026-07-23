import { afterEach, describe, expect, test } from "bun:test";
import { getDefaultModel, models, resolveModel } from "@/agent/model-catalog";

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
