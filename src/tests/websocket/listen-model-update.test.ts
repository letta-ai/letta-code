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
