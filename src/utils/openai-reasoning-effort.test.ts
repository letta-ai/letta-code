import { describe, expect, test } from "bun:test";
import { normalizeReasoningEffortForModel } from "@/utils/openai-reasoning-effort";

describe("normalizeReasoningEffortForModel", () => {
  test.each([
    ["gpt-5.6-sol-1p-codexswic-ev3", "minimal", "none"],
    ["gpt-5.6-sol", "minimal", "none"],
    ["chatgpt-plus-pro/gpt-5.6-sol", "minimal", "none"],
    ["openai-codex/gpt-5.6-sol-fast", "minimal", "none"],
    ["gpt-5.5", "minimal", "none"],
    ["gpt-5.5", "max", "xhigh"],
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5", "minimal", "minimal"],
    ["custom-model", "minimal", "minimal"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    expect(normalizeReasoningEffortForModel(model, effort)).toBe(expected);
  });

  test("passes through empty model and effort values", () => {
    expect(normalizeReasoningEffortForModel(null, "minimal")).toBe("minimal");
    expect(normalizeReasoningEffortForModel("gpt-5.6-sol", null)).toBeNull();
    expect(
      normalizeReasoningEffortForModel("gpt-5.6-sol", undefined),
    ).toBeUndefined();
  });
});
