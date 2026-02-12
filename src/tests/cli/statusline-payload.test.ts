import { describe, expect, test } from "bun:test";
import {
  buildStatusLinePayload,
  calculateContextPercentages,
} from "../../cli/helpers/statusLinePayload";

describe("statusLinePayload", () => {
  test("builds payload with all fields", () => {
    const payload = buildStatusLinePayload({
      modelId: "anthropic/claude-sonnet-4",
      modelDisplayName: "Sonnet",
      currentDirectory: "/repo",
      projectDirectory: "/repo",
      sessionId: "conv-123",
      agentName: "Test Agent",
      totalDurationMs: 10_000,
      totalApiDurationMs: 3_000,
      totalInputTokens: 1200,
      totalOutputTokens: 450,
      contextWindowSize: 200_000,
      usedContextTokens: 40_000,
      permissionMode: "default",
      networkPhase: "download",
      terminalWidth: 120,
    });

    expect(payload.cwd).toBe("/repo");
    expect(payload.workspace.current_dir).toBe("/repo");
    expect(payload.workspace.project_dir).toBe("/repo");
    expect(payload.model.id).toBe("anthropic/claude-sonnet-4");
    expect(payload.model.display_name).toBe("Sonnet");
    expect(payload.context_window.used_percentage).toBe(20);
    expect(payload.context_window.remaining_percentage).toBe(80);
    expect(payload.permission_mode).toBe("default");
    expect(payload.network_phase).toBe("download");
    expect(payload.terminal_width).toBe(120);
  });

  test("marks unsupported fields as null", () => {
    const payload = buildStatusLinePayload({
      currentDirectory: "/repo",
      projectDirectory: "/repo",
    });

    expect(payload.transcript_path).toBeNull();
    expect(payload.output_style.name).toBeNull();
    expect(payload.vim).toBeNull();
    expect(payload.cost.total_cost_usd).toBeNull();
    expect(payload.context_window.current_usage).toBeNull();
  });

  test("calculates context percentages safely", () => {
    expect(calculateContextPercentages(50, 200)).toEqual({
      used: 25,
      remaining: 75,
    });
    expect(calculateContextPercentages(500, 200)).toEqual({
      used: 100,
      remaining: 0,
    });
  });
});
