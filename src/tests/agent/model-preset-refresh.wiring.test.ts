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

  test("modify.ts keeps direct updateArgs-driven model update flow", () => {
    const path = fileURLToPath(
      new URL("../../agent/modify.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    const start = source.indexOf("export async function updateAgentLLMConfig(");
    const end = source.indexOf("export interface SystemPromptUpdateResult", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const updateSegment = source.slice(start, end);

    expect(updateSegment).toContain(
      "buildModelSettings(modelHandle, updateArgs)",
    );
    expect(updateSegment).toContain("getModelContextWindow(modelHandle)");
    expect(updateSegment).not.toContain(
      "const currentAgent = await client.agents.retrieve(",
    );
    expect(source).not.toContain(
      'hasUpdateArg(updateArgs, "parallel_tool_calls")',
    );
  });
});
