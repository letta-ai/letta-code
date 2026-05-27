import { describe, expect, test } from "bun:test";
import { resolveReasoningCycleModelHandle } from "@/cli/app/use-reasoning-cycle";

describe("resolveReasoningCycleModelHandle", () => {
  test("preserves local model handles from llm_config", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "ollama/gemma4:latest",
          model_endpoint_type: "openai",
          context_window: 128000,
        },
        null,
      ),
    ).toBe("ollama/gemma4:latest");
  });

  test("uses local agent model before compatibility llm_config endpoint", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "ollama/gemma4:latest",
          model_endpoint_type: "openai",
          context_window: 128000,
        },
        "ollama/gemma4:latest",
      ),
    ).toBe("ollama/gemma4:latest");
  });

  test("keeps provider-prefixed cloud handles for non-local models", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "gpt-5.4",
          model_endpoint_type: "openai",
          context_window: 128000,
        },
        null,
      ),
    ).toBe("openai/gpt-5.4");
  });

  test("maps ChatGPT OAuth endpoint type to the model registry provider", () => {
    expect(
      resolveReasoningCycleModelHandle(
        {
          model: "gpt-5.5",
          model_endpoint_type: "chatgpt_oauth",
          context_window: 128000,
        },
        null,
      ),
    ).toBe("chatgpt-plus-pro/gpt-5.5");
  });
});
