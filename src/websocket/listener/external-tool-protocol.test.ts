import { describe, expect, test } from "bun:test";
import { isRuntimeStartExternalToolsGroup } from "./external-tool-protocol";

describe("external tool timeout registration", () => {
  const tool = {
    name: "quick_action",
    description: "Return a quick receipt",
    parameters: { type: "object" },
  };

  test("accepts a safe millisecond timeout", () => {
    expect(
      isRuntimeStartExternalToolsGroup({
        tools: [{ ...tool, timeout_ms: 1_000 }],
      }),
    ).toBe(true);
  });

  test("rejects invalid deadlines instead of silently falling back to five minutes", () => {
    for (const timeout_ms of [0, -1, 500, 300_001, 1.5, "1000"]) {
      expect(
        isRuntimeStartExternalToolsGroup({ tools: [{ ...tool, timeout_ms }] }),
      ).toBe(false);
    }
  });

  test("accepts an explicit inline override and rejects invalid background flags", () => {
    expect(
      isRuntimeStartExternalToolsGroup({
        tools: [{ ...tool, auto_background: false }],
      }),
    ).toBe(true);
    expect(
      isRuntimeStartExternalToolsGroup({
        tools: [{ ...tool, auto_background: true }],
      }),
    ).toBe(true);
    for (const auto_background of [0, null, "false"]) {
      expect(
        isRuntimeStartExternalToolsGroup({
          tools: [{ ...tool, auto_background }],
        }),
      ).toBe(false);
    }
  });
});
