import { describe, expect, test } from "bun:test";
import { isSetReflectionSettingsCommand } from "@/websocket/listener/protocol-inbound";

function command(settings: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "set_reflection_settings",
    request_id: "request-1",
    runtime: { agent_id: "agent-1", conversation_id: "default" },
    settings,
  };
}

describe("reflection merge settings protocol", () => {
  test("accepts explicit merge settings and optional instructions", () => {
    expect(
      isSetReflectionSettingsCommand(
        command({
          trigger: "step-count",
          step_count: 25,
          merge: "explicit",
          merge_instructions: "Preserve exact wording.",
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
});
