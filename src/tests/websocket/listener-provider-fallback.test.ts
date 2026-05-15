import { describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  createProviderFallbackState,
  maybeApplyProviderFallback,
} from "../../websocket/listener/providerFallback";

function agentWithModel(
  model: string,
  extra: Partial<AgentState["llm_config"]> = {},
): AgentState {
  return {
    llm_config: {
      context_window: 200000,
      model,
      model_endpoint_type: "anthropic",
      ...extra,
    },
  } as AgentState;
}

describe("listener provider fallback", () => {
  test("maps sonnet to Bedrock after the first retry attempt", () => {
    const state = createProviderFallbackState(
      agentWithModel("anthropic/claude-sonnet-4-6", {
        reasoning_effort: "high",
        enable_reasoner: true,
      }),
    );

    expect(state.sourceModelId).toBe("sonnet");
    expect(maybeApplyProviderFallback(state, 1)).toBeNull();

    const fallbackHandle = maybeApplyProviderFallback(state, 2);
    expect(fallbackHandle).toBe("bedrock/us.anthropic.claude-sonnet-4-6");
    expect(state.overrideModel).toBe("bedrock/us.anthropic.claude-sonnet-4-6");
    expect(state.attempted).toBe(true);
    expect(maybeApplyProviderFallback(state, 3)).toBeNull();
  });

  test("leaves non-Anthropic models unchanged", () => {
    const state = createProviderFallbackState(
      agentWithModel("openai/gpt-5.4", {
        model_endpoint_type: "openai",
        reasoning_effort: "high",
      }),
    );

    expect(state.sourceModelId).toBe("gpt-5.4-high");
    expect(maybeApplyProviderFallback(state, 2)).toBeNull();
    expect(state.overrideModel).toBeUndefined();
  });
});
