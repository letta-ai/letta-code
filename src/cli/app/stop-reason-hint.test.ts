import { describe, expect, test } from "bun:test";
import { ERROR_FEEDBACK_HINT } from "./constants";
import { getErrorHintForStopReason } from "./model-config";

describe("getErrorHintForStopReason", () => {
  test("explains max_tokens_exceeded as a per-response output limit with the configured cap", () => {
    const hint = getErrorHintForStopReason(
      "max_tokens_exceeded",
      "openrouter/openai/gpt-6-luna",
      { model_endpoint_type: "openrouter", max_tokens: 4096 },
    );

    expect(hint).toContain("4,096-token output limit");
    expect(hint).toContain("not a spending or usage cap");
    expect(hint).toContain("/model");
    expect(hint).not.toBe(ERROR_FEEDBACK_HINT);
  });

  test("explains max_tokens_exceeded without a number when the cap is unknown", () => {
    const hint = getErrorHintForStopReason("max_tokens_exceeded", null, null);

    expect(hint).toContain("its output token limit");
    expect(hint).toContain("not a spending or usage cap");
  });

  test("keeps the generic feedback hint for other non-provider stop reasons", () => {
    expect(getErrorHintForStopReason("error", null, null)).toBe(
      ERROR_FEEDBACK_HINT,
    );
  });

  test("still points llm_api_error at the selected provider's status page", () => {
    const hint = getErrorHintForStopReason(
      "llm_api_error",
      "anthropic/claude",
      {
        model_endpoint_type: "anthropic",
        max_tokens: 4096,
      },
    );

    expect(hint).toContain("Downstream provider");
    expect(hint).not.toContain("output limit");
  });
});
