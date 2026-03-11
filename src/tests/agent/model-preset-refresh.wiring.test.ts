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

  test("modify.ts supports preserving context window during resume refresh", () => {
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
    expect(source).toContain("export interface UpdateAgentLLMConfigOptions");
    expect(updateSegment).toContain("options?: UpdateAgentLLMConfigOptions");
    expect(updateSegment).toContain("shouldPreserveContextWindow");
    expect(updateSegment).toContain("getModelContextWindow(modelHandle)");
    expect(updateSegment).toContain("options?.preserveContextWindow === true");
    expect(updateSegment).not.toContain(
      "(updateArgs?.context_window as number | undefined) ??\n    (await getModelContextWindow(modelHandle));",
    );
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

  test("/model handler updates conversation model (default updates agent)", () => {
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
    expect(segment).toContain("updateAgentLLMConfig(");
    expect(segment).toContain("conversationIdRef.current");
    expect(segment).toContain('conversationIdRef.current === "default"');
  });

  test("App defines helper to carry over active conversation model", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    const start = source.indexOf(
      "const maybeCarryOverActiveConversationModel = useCallback(",
    );
    const end = source.indexOf(
      "// Helper to append an error to the transcript",
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const segment = source.slice(start, end);

    expect(segment).toContain("hasConversationModelOverrideRef.current");
    expect(segment).toContain("buildModelHandleFromLlmConfig");
    expect(segment).toContain("getModelInfoForLlmConfig(");
    expect(segment).toContain("updateConversationLLMConfig(");
    expect(segment).toContain(
      "Failed to carry over active model to new conversation",
    );
  });

  test("conversation model override flag is synced for async callbacks", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    // The override flag must be safe to read inside async callbacks (e.g. the
    // first streamed chunk sync) without waiting for a render/effect.
    expect(source).toMatch(
      /\[\s*hasConversationModelOverride,\s*setHasConversationModelOverride,\s*hasConversationModelOverrideRef,\s*\]\s*=\s*useSyncedState\(false\)/,
    );
  });

  test("reasoning tier prefers conversation override model_settings", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    // When a conversation override is active, prefer the conversation model_settings
    // snapshot when deriving reasoning effort (not the base agent llm_config).
    expect(source).toMatch(
      /const effectiveModelSettings = hasConversationModelOverride\s*\?\s*conversationOverrideModelSettings\s*:\s*agentState\?\.model_settings;/,
    );
  });

  test("new conversation flows reapply active conversation model before switching", () => {
    const path = fileURLToPath(new URL("../../cli/App.tsx", import.meta.url));
    const source = readFileSync(path, "utf-8");

    const carryOverCalls =
      source.match(
        /await maybeCarryOverActiveConversationModel\(\s*conversation\.id,?\s*\);/g,
      ) ?? [];
    expect(carryOverCalls.length).toBeGreaterThanOrEqual(3);

    const newCmdAnchor = source.indexOf('if (msg.trim() === "/new")');
    expect(newCmdAnchor).toBeGreaterThanOrEqual(0);
    const newCmdWindow = source.slice(newCmdAnchor, newCmdAnchor + 1800);
    expect(newCmdWindow).toContain(
      "await maybeCarryOverActiveConversationModel(conversation.id);",
    );

    const clearAnchor = source.indexOf('if (msg.trim() === "/clear")');
    expect(clearAnchor).toBeGreaterThanOrEqual(0);
    const clearWindow = source.slice(clearAnchor, clearAnchor + 2000);
    expect(clearWindow).toContain(
      "await maybeCarryOverActiveConversationModel(conversation.id);",
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
    // Field extraction + skip logic is handled by getResumeRefreshArgs helper
    expect(source).toContain("getResumeRefreshArgs(presetRefresh.updateArgs");
    expect(source).toContain("needsUpdate");
    expect(source).toContain("await updateAgentLLMConfig(");
    expect(source).toContain("presetRefresh.modelHandle");
    expect(source).toMatch(
      /resumeRefreshUpdateArgs,\s*\{\s*preserveContextWindow:\s*true\s*\},/,
    );
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
    expect(source).toMatch(
      /resumeRefreshUpdateArgs,\s*\{\s*preserveContextWindow:\s*true\s*\},/,
    );
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
