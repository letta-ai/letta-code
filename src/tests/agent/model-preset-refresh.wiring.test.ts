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

  test("modify.ts exposes conversation-scoped model updater", () => {
    const path = fileURLToPath(
      new URL("../../agent/modify.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    const start = source.indexOf(
      "export async function updateConversationLLMConfig(",
    );
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
    expect(updateSegment).toContain(
      "Parameters<typeof client.conversations.update>[1]",
    );
    expect(updateSegment).toContain(
      "client.conversations.update(conversationId, payload)",
    );
    expect(updateSegment).toContain("model: modelHandle");
    expect(updateSegment).not.toContain("client.agents.update(");
  });

  test("/model handler updates conversation model (not agent model)", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    const start = source.indexOf("const handleModelSelect = useCallback(");
    const end = source.indexOf(
      "const handleSystemPromptSelect = useCallback(",
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const segment = source.slice(start, end);

    expect(segment).toContain("updateConversationLLMConfig(");
    expect(segment).toContain("conversationIdRef.current");
    expect(segment).not.toContain("updateAgentLLMConfig(");
  });

  test("interactive resume flow refreshes model preset without explicit --model", () => {
    const path = fileURLToPath(new URL("../../index.ts", import.meta.url));
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("if (resuming)");
    expect(source).toContain("getModelPresetUpdateForAgent");
    expect(source).toContain(
      "const presetRefresh = getModelPresetUpdateForAgent(agent)",
    );
    // Field extraction + skip logic is handled by getResumeRefreshArgs helper
    expect(source).toContain("getResumeRefreshArgs(presetRefresh.updateArgs");
    expect(source).toContain("needsUpdate");
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
    // Field extraction + skip logic is handled by getResumeRefreshArgs helper
    expect(source).toContain("getResumeRefreshArgs(presetRefresh.updateArgs");
    expect(source).toContain("needsUpdate");
    expect(source).toContain("await updateAgentLLMConfig(");
    expect(source).toContain("presetRefresh.modelHandle");
    expect(source).not.toContain(
      "await updateAgentLLMConfig(\n          agent.id,\n          presetRefresh.modelHandle,\n          presetRefresh.updateArgs,",
    );
  });

  test("getResumeRefreshArgs helper owns field extraction and comparison", () => {
    const path = fileURLToPath(
      new URL("../../agent/model.ts", import.meta.url),
    );
    const source = readFileSync(path, "utf-8");

    expect(source).toContain("export function getResumeRefreshArgs(");
    expect(source).toContain("RESUME_REFRESH_FIELDS");
    expect(source).toContain('"max_output_tokens"');
    expect(source).toContain('"parallel_tool_calls"');
    expect(source).toContain("needsUpdate");
  });
});
