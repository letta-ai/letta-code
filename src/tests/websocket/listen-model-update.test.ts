import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { __listenClientTestUtils } from "../../websocket/listen-client";

/**
 * Tests for the model update command logic.
 *
 * These tests deliberately avoid mock.module to prevent mock leakage
 * across bun's shared test module graph. Pure function tests cover the
 * conditional status message and error handling; structural assertions
 * verify wiring that can't be tested without mocking API calls.
 */

describe("listen-client model update status message", () => {
  test("emits only model name when toolset did not change", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Claude Sonnet 4",
      toolsetChanged: false,
      toolsetError: null,
      nextToolset: "default",
      toolsetPreference: "auto",
    });

    expect(result.message).toBe("Model updated to Claude Sonnet 4.");
    expect(result.level).toBe("info");
  });

  test("includes toolset notice when toolset changed (auto preference)", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "GPT-5",
      toolsetChanged: true,
      toolsetError: null,
      nextToolset: "codex",
      toolsetPreference: "auto",
    });

    expect(result.message).toContain("Model updated to GPT-5.");
    expect(result.message).toContain("auto");
    expect(result.level).toBe("info");
  });

  test("includes toolset notice when toolset changed (manual override)", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "GPT-5",
      toolsetChanged: true,
      toolsetError: null,
      nextToolset: "codex",
      toolsetPreference: "codex",
    });

    expect(result.message).toContain("Model updated to GPT-5.");
    expect(result.message).toContain("Manual toolset override");
    expect(result.level).toBe("info");
  });

  test("includes reasoning effort when updateArgs has reasoning_effort", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Opus 4.6",
      toolsetChanged: false,
      toolsetError: null,
      nextToolset: "default",
      toolsetPreference: "auto",
      updateArgs: { reasoning_effort: "medium" },
    });

    expect(result.message).toBe("Model updated to Opus 4.6 (Medium).");
    expect(result.level).toBe("info");
  });

  test("shows No Reasoning for reasoning_effort none", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Opus 4.6",
      toolsetChanged: false,
      toolsetError: null,
      nextToolset: "default",
      toolsetPreference: "auto",
      updateArgs: { reasoning_effort: "none" },
    });

    expect(result.message).toBe("Model updated to Opus 4.6 (No Reasoning).");
  });

  test("shows Max for reasoning_effort xhigh", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Opus 4.6",
      toolsetChanged: false,
      toolsetError: null,
      nextToolset: "default",
      toolsetPreference: "auto",
      updateArgs: { reasoning_effort: "xhigh" },
    });

    expect(result.message).toBe("Model updated to Opus 4.6 (Max).");
  });

  test("omits effort when updateArgs has no reasoning_effort", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "GLM-5",
      toolsetChanged: false,
      toolsetError: null,
      nextToolset: "default",
      toolsetPreference: "auto",
      updateArgs: { context_window: 180000 },
    });

    expect(result.message).toBe("Model updated to GLM-5.");
  });

  test("reports warning level when toolset switch failed", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Claude Sonnet 4",
      toolsetChanged: false,
      toolsetError: "Network timeout",
      nextToolset: "default",
      toolsetPreference: "auto",
    });

    expect(result.message).toContain("Model updated to Claude Sonnet 4.");
    expect(result.message).toContain("Warning: toolset switch failed");
    expect(result.message).toContain("Network timeout");
    expect(result.level).toBe("warning");
  });

  test("toolset error takes precedence over toolset change flag", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "GPT-5",
      toolsetChanged: true,
      toolsetError: "API unreachable",
      nextToolset: "codex",
      toolsetPreference: "auto",
    });

    // Should show warning, not the toolset change notice
    expect(result.message).toContain("Warning: toolset switch failed");
    expect(result.message).not.toContain("auto");
    expect(result.level).toBe("warning");
  });
});

describe("listen-client applyModelUpdateForRuntime wiring", () => {
  test("uses getToolNames for change detection and wraps toolset switch in try/catch", () => {
    const clientPath = fileURLToPath(
      new URL("../../websocket/listener/client.ts", import.meta.url),
    );
    const source = readFileSync(clientPath, "utf-8");

    // Fix #1: toolset change detection uses getToolNames() snapshot comparison
    expect(source).toContain("const previousToolNames = getToolNames()");
    expect(source).toContain(
      "JSON.stringify(previousToolNames) !== JSON.stringify(getToolNames())",
    );

    // Fix #2: toolset switch is wrapped in its own try/catch
    // The pattern: try { switchToolsetForModel/forceToolsetSwitch } catch { toolsetError = ... }
    // followed by success: true in the return (model update succeeded even if toolset failed)
    expect(source).toContain("toolsetError =");
    expect(source).toContain(
      'error instanceof Error ? error.message : "Failed to switch toolset"',
    );
  });

  test("routes default conversations to agent update and non-default to conversation update", () => {
    const clientPath = fileURLToPath(
      new URL("../../websocket/listener/client.ts", import.meta.url),
    );
    const source = readFileSync(clientPath, "utf-8");

    // Agent-scoped update for default conversation
    expect(source).toContain('conversationId === "default"');
    expect(source).toContain("updateAgentLLMConfig(");
    expect(source).toContain('appliedTo = "agent"');

    // Conversation-scoped update for non-default
    expect(source).toContain("updateConversationLLMConfig(");
    expect(source).toContain('appliedTo = "conversation"');
  });
});

describe("listen-client list_models response wiring", () => {
  test("buildListModelsResponse is async and uses Promise.allSettled for parallel fetches", () => {
    const clientPath = fileURLToPath(
      new URL("../../websocket/listener/client.ts", import.meta.url),
    );
    const source = readFileSync(clientPath, "utf-8");

    // The response builder should use Promise.allSettled for parallel fetches
    expect(source).toContain("Promise.allSettled");
    expect(source).toContain("getAvailableModelHandles()");
    expect(source).toContain("listProviders()");
    expect(source).toContain("buildByokProviderAliases(providers)");
  });

  test("handler uses async pattern with buildListModelsResponse", () => {
    const clientPath = fileURLToPath(
      new URL("../../websocket/listener/client.ts", import.meta.url),
    );
    const source = readFileSync(clientPath, "utf-8");

    // Handler should be wrapped in void (async () => { ... })() pattern
    expect(source).toContain("buildListModelsResponse(parsed.request_id)");
  });

  test("response type includes available_handles and byok_provider_aliases fields", () => {
    const clientPath = fileURLToPath(
      new URL("../../websocket/listener/client.ts", import.meta.url),
    );
    const source = readFileSync(clientPath, "utf-8");

    // The response payload should include the new fields
    expect(source).toContain("available_handles: availableHandles");
    expect(source).toContain("byok_provider_aliases: byokProviderAliases");
  });

  test("available_handles is null when availability fetch fails (degraded path)", () => {
    const clientPath = fileURLToPath(
      new URL("../../websocket/listener/client.ts", import.meta.url),
    );
    const source = readFileSync(clientPath, "utf-8");

    // Should handle rejected availability fetch by returning null
    expect(source).toContain('handlesResult.status === "fulfilled"');
    // Null fallback when fetch fails
    expect(source).toContain(": null");
  });

  test("buildListModelsEntries returns entries with expected shape", () => {
    const entries = __listenClientTestUtils.buildListModelsEntries();

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    // Every entry should have required fields
    for (const entry of entries) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.handle).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.description).toBe("string");
    }
  });

  test("buildListModelsEntries preserves updateArgs when present", () => {
    const entries = __listenClientTestUtils.buildListModelsEntries();

    // At least some entries should have updateArgs (models with config)
    const withUpdateArgs = entries.filter(
      (e) => e.updateArgs && Object.keys(e.updateArgs).length > 0,
    );
    expect(withUpdateArgs.length).toBeGreaterThan(0);

    // At least some entries with updateArgs should have reasoning_effort
    const withReasoningEffort = withUpdateArgs.filter(
      (e) => "reasoning_effort" in (e.updateArgs as Record<string, unknown>),
    );
    expect(withReasoningEffort.length).toBeGreaterThan(0);
  });

  test("buildListModelsResponse is exposed on test utils", () => {
    expect(typeof __listenClientTestUtils.buildListModelsResponse).toBe(
      "function",
    );
  });
});
