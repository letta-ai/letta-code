import { describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  resolveReasoningCycleModelHandle,
  serviceTierForReasoningCycle,
} from "@/cli/app/use-reasoning-cycle";

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

describe("serviceTierForReasoningCycle", () => {
  test("preserves local ChatGPT Fast priority service tier", () => {
    expect(
      serviceTierForReasoningCycle("openai-codex/gpt-5.5", {
        provider_type: "chatgpt_oauth",
        service_tier: "priority",
      } as unknown as AgentState["model_settings"]),
    ).toBe("priority");
  });

  test("clears local ChatGPT service tier when not priority", () => {
    expect(
      serviceTierForReasoningCycle("openai-codex/gpt-5.5", {
        provider_type: "chatgpt_oauth",
        service_tier: null,
      } as unknown as AgentState["model_settings"]),
    ).toBeNull();
  });

  test("ignores non-ChatGPT Fast-capable models", () => {
    expect(
      serviceTierForReasoningCycle("openai/gpt-5.5", {
        provider_type: "openai",
        service_tier: "priority",
      } as unknown as AgentState["model_settings"]),
    ).toBeUndefined();
  });
});
