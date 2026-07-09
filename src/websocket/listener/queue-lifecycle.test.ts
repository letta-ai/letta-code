import { describe, expect, test } from "bun:test";

import { resolveTurnLifecycleTerminal } from "./queue";

describe("channel turn terminal mapping", () => {
  test.each([
    ["end_turn", "completed"],
    ["tool_rule", "completed"],
    ["cancelled", "cancelled"],
    ["error", "error"],
    ["llm_api_error", "error"],
    ["invalid_llm_response", "error"],
    ["invalid_tool_call", "error"],
    ["max_steps", "error"],
    ["max_tokens_exceeded", "error"],
    ["no_tool_call", "error"],
    ["insufficient_credits", "error"],
    ["context_window_overflow_in_system_prompt", "error"],
  ] as const)(
    "preserves %s instead of collapsing it",
    (stopReason, outcome) => {
      expect(resolveTurnLifecycleTerminal(stopReason, false)).toEqual({
        outcome,
        stopReason,
      });
    },
  );

  test("a thrown turn cannot report a stale successful stop reason", () => {
    expect(resolveTurnLifecycleTerminal("end_turn", true)).toEqual({
      outcome: "error",
      stopReason: "error",
    });
  });

  test("requires_approval remains distinguishable as a continuation boundary", () => {
    expect(resolveTurnLifecycleTerminal("requires_approval", false)).toEqual({
      outcome: "error",
      stopReason: "requires_approval",
    });
  });
});
