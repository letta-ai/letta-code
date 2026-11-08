import { describe, expect, test } from "bun:test";
import {
  clearAutomaticReflectionSuppression,
  isAutomaticReflectionSuppressed,
  recordReflectionConfigurationFailure,
} from "@/cli/helpers/reflection-launcher";
import { clearSuppressionForReflectionModelChange } from "@/websocket/listener/commands/settings";
import { isSetReflectionSettingsCommand } from "@/websocket/listener/protocol-inbound";

function command(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "set_reflection_settings",
    request_id: "request-1",
    runtime: { agent_id: "agent-1", conversation_id: "default" },
    settings,
  };
}

describe("reflection settings protocol", () => {
  test("accepts explicit merge settings, instructions, and a model", () => {
    expect(
      isSetReflectionSettingsCommand(
        command({
          trigger: "step-count",
          step_count: 25,
          merge: "explicit",
          merge_instructions: "Preserve exact wording.",
          model: "anthropic/claude-haiku-4-5",
        }),
      ),
    ).toBe(true);
  });

  test("keeps older trigger-only clients compatible", () => {
    expect(
      isSetReflectionSettingsCommand(
        command({ trigger: "compaction-event", step_count: 25 }),
      ),
    ).toBe(true);
  });

  test("accepts null to reset the reflection model", () => {
    expect(
      isSetReflectionSettingsCommand(
        command({
          trigger: "compaction-event",
          step_count: 25,
          model: null,
        }),
      ),
    ).toBe(true);
  });

  test("rejects invalid merge settings", () => {
    expect(
      isSetReflectionSettingsCommand(
        command({ trigger: "step-count", step_count: 25, merge: "ask" }),
      ),
    ).toBe(false);
    expect(
      isSetReflectionSettingsCommand(
        command({
          trigger: "step-count",
          step_count: 25,
          merge: "explicit",
          merge_instructions: 42,
        }),
      ),
    ).toBe(false);
  });

  test("rejects empty or non-string reflection models", () => {
    for (const model of ["", "   ", 42, false]) {
      expect(
        isSetReflectionSettingsCommand(
          command({
            trigger: "step-count",
            step_count: 25,
            model,
          }),
        ),
      ).toBe(false);
    }
  });

  test("clears automatic-reflection suppression when the model changes", () => {
    const agentId = "agent-reflection-model-change";
    clearAutomaticReflectionSuppression(agentId);
    expect(
      recordReflectionConfigurationFailure({
        agentId,
        model: "openai/removed-model",
        error: "Model handle not found: openai/removed-model",
      }),
    ).toBe(true);
    expect(isAutomaticReflectionSuppressed(agentId)).toBe(true);

    clearSuppressionForReflectionModelChange(
      agentId,
      "openai/removed-model",
      "anthropic/claude-haiku-4-5",
    );

    expect(isAutomaticReflectionSuppressed(agentId)).toBe(false);
  });
});
