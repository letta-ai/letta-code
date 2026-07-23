import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";
import {
  createProviderFallbackState,
  maybeApplyProviderFallback,
} from "@/websocket/listener/provider-fallback";

beforeEach(installRuntimeModelCatalogFixture);
afterEach(clearRuntimeModelCatalogFixture);

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
      agentWithModel("anthropic/claude-sonnet-5", {
        reasoning_effort: "high",
        enable_reasoner: true,
      }),
    );

    expect(state.sourceModelId).toBe("sonnet");
    expect(maybeApplyProviderFallback(state, 1)).toBeNull();

    const fallbackHandle = maybeApplyProviderFallback(state, 2);
    expect(fallbackHandle).toBe("bedrock/us.anthropic.claude-sonnet-5");
    expect(state.overrideModel).toBe("bedrock/us.anthropic.claude-sonnet-5");
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

  test("maps Opus 4.7 aliases to Bedrock Opus 4.7", () => {
    for (const [model, sourceModelId] of [
      ["anthropic/claude-opus-4-7", "opus-4.7-medium"],
      ["opus-4.7-high", "opus-4.7-high"],
      ["opus-4.7-max", "opus-4.7-max"],
    ] as const) {
      const state = createProviderFallbackState(agentWithModel(model));

      expect(state.sourceModelId).toBe(sourceModelId);
      expect(maybeApplyProviderFallback(state, 2)).toBe(
        "bedrock/us.anthropic.claude-opus-4-7",
      );
      expect(state.overrideModel).toBe("bedrock/us.anthropic.claude-opus-4-7");
    }
  });
});
