import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("model preset refresh wiring", () => {
  test("model.ts exports preset refresh helper", () => {
    const path = fileURLToPath(
      new URL("../../agent/model.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("export function getModelPresetUpdateForAgent(");
    expect(source).toContain("OPENAI_CODEX_PROVIDER_NAME");
    expect(source).toContain("getModelInfoForLlmConfig(modelHandle");
  });

  test("modify.ts supports selective parallel_tool_calls updates", () => {
    const path = fileURLToPath(
      new URL("../../agent/modify.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain('hasUpdateArg(updateArgs, "parallel_tool_calls")');
    expect(source).toContain("const settings: Record<string, unknown> = {");
    expect(source).toContain("...existingModelSettings");
    expect(source).toContain('hasUpdateArg(updateArgs, "context_window")');
    expect(source).toContain('hasUpdateArg(updateArgs, "max_output_tokens")');
  });
});
