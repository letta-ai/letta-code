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
    const end = source.indexOf(
      "export interface SystemPromptUpdateResult",
      start,
    );
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

  test("interactive resume flow refreshes model preset without explicit --model", () => {
    const path = fileURLToPath(new URL("../../index.ts", import.meta.url));
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("if (resuming)");
    expect(source).toContain("getModelPresetUpdateForAgent");
    expect(source).toContain(
      "const presetRefresh = getModelPresetUpdateForAgent(agent)",
    );
    expect(source).toContain("resumeRefreshUpdateArgs");
    expect(source).toContain("presetRefresh.updateArgs.max_output_tokens");
    expect(source).toContain("presetRefresh.updateArgs.parallel_tool_calls");
    expect(source).toContain("await updateAgentLLMConfig(");
    expect(source).toContain("presetRefresh.modelHandle");
    expect(source).not.toContain(
      "await updateAgentLLMConfig(\n                agent.id,\n                presetRefresh.modelHandle,\n                presetRefresh.updateArgs,",
    );
  });

  test("headless resume flow refreshes model preset without explicit --model", () => {
    const path = fileURLToPath(new URL("../../headless.ts", import.meta.url));
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("if (isResumingAgent)");
    expect(source).toContain("getModelPresetUpdateForAgent");
    expect(source).toContain(
      "const presetRefresh = getModelPresetUpdateForAgent(agent)",
    );
    expect(source).toContain("resumeRefreshUpdateArgs");
    expect(source).toContain("presetRefresh.updateArgs.max_output_tokens");
    expect(source).toContain("presetRefresh.updateArgs.parallel_tool_calls");
    expect(source).toContain("await updateAgentLLMConfig(");
    expect(source).toContain("presetRefresh.modelHandle");
    expect(source).not.toContain(
      "await updateAgentLLMConfig(\n          agent.id,\n          presetRefresh.modelHandle,\n          presetRefresh.updateArgs,",
    );
  });
});
