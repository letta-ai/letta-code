import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend/backend";
import { clearAvailableModelsCache } from "./available-models";
import { updateExistingAgentLLMConfig } from "./existing-agent-model-update";
import { updateAgentLLMConfig } from "./modify";

type UpdateCall = { id: string; body: Record<string, unknown> };

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: "agent-1",
    name: "Configured agent",
    system: "custom system prompt",
    model: "anthropic/claude-sonnet-5",
    model_settings: {
      provider_type: "anthropic",
      effort: "medium",
      parallel_tool_calls: false,
      temperature: 0.2,
    },
    llm_config: {
      model: "claude-sonnet-5",
      model_endpoint_type: "anthropic",
      context_window: 65_536,
      max_tokens: 4_096,
    },
    ...overrides,
  } as AgentState;
}

function makeBackend(options?: {
  agent?: AgentState;
  localModelCatalog?: boolean;
  listedModels?: Array<Record<string, unknown>>;
  listModelsError?: Error;
}) {
  let currentAgent = options?.agent ?? makeAgent();
  const calls: UpdateCall[] = [];
  const backend = {
    capabilities: {
      localModelCatalog: options?.localModelCatalog ?? false,
    },
    listModels: async () => {
      if (options?.listModelsError) throw options.listModelsError;
      return (
        options?.listedModels ?? [
          {
            handle: "openai/gpt-5.6-sol",
            max_context_window: 350_000,
            max_tokens: 128_000,
            provider_type: "openai",
          },
        ]
      );
    },
    updateAgent: async (id: string, body: Record<string, unknown>) => {
      calls.push({ id, body });
      const llmConfig = {
        ...(currentAgent.llm_config ?? {}),
        ...(typeof body.context_window_limit === "number"
          ? { context_window: body.context_window_limit }
          : {}),
        ...(typeof body.max_tokens === "number" || body.max_tokens === null
          ? { max_tokens: body.max_tokens }
          : {}),
      };
      currentAgent = {
        ...currentAgent,
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(body.model_settings
          ? {
              model_settings:
                body.model_settings as AgentState["model_settings"],
            }
          : {}),
        llm_config: llmConfig,
      };
      return currentAgent;
    },
    retrieveAgent: async () => currentAgent,
  } as unknown as Backend;
  return { backend, calls };
}

beforeEach(() => {
  clearAvailableModelsCache();
});

afterEach(() => {
  __testSetBackend(null);
  clearAvailableModelsCache();
});

describe("existing-agent model updates", () => {
  test("uses agent generation settings as the baseline while changing model and reasoning", async () => {
    const currentAgent = makeAgent();
    const { backend, calls } = makeBackend({ agent: currentAgent });
    __testSetBackend(backend);

    const result = await updateExistingAgentLLMConfig(
      currentAgent,
      "openai/gpt-5.6-sol",
      {
        context_window: 350_000,
        max_output_tokens: 128_000,
        reasoning_effort: "high",
        verbosity: "medium",
        parallel_tool_calls: true,
      },
    );

    expect(result.warnings).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      model: "openai/gpt-5.6-sol",
      context_window_limit: 65_536,
      max_tokens: 4_096,
      model_settings: {
        provider_type: "openai",
        parallel_tool_calls: true,
        reasoning: { reasoning_effort: "high" },
        verbosity: "medium",
        max_output_tokens: 4_096,
        temperature: 0.2,
      },
    });
    expect(result.agent.system).toBe(currentAgent.system);
  });

  test("clamps existing caps to backend-reported destination limits", async () => {
    const currentAgent = makeAgent({
      llm_config: {
        model: "claude-sonnet-5",
        model_endpoint_type: "anthropic",
        context_window: 1_000_000,
        max_tokens: 256_000,
      },
    });
    const { backend, calls } = makeBackend({ agent: currentAgent });
    __testSetBackend(backend);

    const result = await updateExistingAgentLLMConfig(
      currentAgent,
      "openai/gpt-5.6-sol",
      {
        context_window: 350_000,
        max_output_tokens: 128_000,
        reasoning_effort: "high",
      },
    );

    expect(calls[0]?.body.context_window_limit).toBe(350_000);
    expect(calls[0]?.body.max_tokens).toBe(128_000);
    expect(result.warnings).toEqual([
      "Clamped preserved context_window_limit from 1000000 to 350000 for the selected model.",
      "Clamped preserved max_tokens from 256000 to 128000 for the selected model.",
    ]);
  });

  test("same-handle reasoning changes preserve caps when catalog limits are absent", async () => {
    const currentAgent = makeAgent({
      model: "openai/gpt-5.6-sol",
      model_settings: {
        provider_type: "openai",
        reasoning: { reasoning_effort: "low" },
        temperature: 0.4,
      },
      llm_config: {
        model: "gpt-5.6-sol",
        model_endpoint_type: "openai",
        context_window: 65_536,
        max_tokens: 4_096,
      },
    });
    const { backend, calls } = makeBackend({
      agent: currentAgent,
      listedModels: [{ handle: "openai/gpt-5.6-sol" }],
    });
    __testSetBackend(backend);

    const result = await updateExistingAgentLLMConfig(
      currentAgent,
      "openai/gpt-5.6-sol",
      { reasoning_effort: "xhigh" },
    );

    expect(result.warnings).toEqual([]);
    expect(calls[0]?.body).toMatchObject({
      model: "openai/gpt-5.6-sol",
      context_window_limit: 65_536,
      max_tokens: 4_096,
      model_settings: {
        reasoning: { reasoning_effort: "xhigh" },
        temperature: 0.4,
      },
    });
  });

  test("uses live output limits when a preset omits max_output_tokens", async () => {
    const currentAgent = makeAgent({
      llm_config: {
        model: "claude-sonnet-5",
        model_endpoint_type: "anthropic",
        context_window: 65_536,
        max_tokens: 40_000,
      },
    });
    const { backend, calls } = makeBackend({
      agent: currentAgent,
      listedModels: [
        {
          handle: "minimax/MiniMax-M3",
          max_context_window: 500_000,
          max_tokens: 32_000,
          provider_type: "anthropic",
        },
      ],
    });
    __testSetBackend(backend);

    const result = await updateExistingAgentLLMConfig(
      currentAgent,
      "minimax/MiniMax-M3",
      { context_window: 500_000, parallel_tool_calls: true },
    );

    expect(calls[0]?.body.max_tokens).toBe(32_000);
    expect(result.warnings).toContain(
      "Clamped preserved max_tokens from 40000 to 32000 for the selected model.",
    );
  });

  test("uses backend catalog provider identity for custom destination handles", async () => {
    const currentAgent = makeAgent();
    const { backend, calls } = makeBackend({
      agent: currentAgent,
      listedModels: [
        {
          handle: "custom/hosted-claude",
          max_context_window: 200_000,
          max_tokens: 32_000,
          provider_type: "anthropic",
        },
      ],
    });
    __testSetBackend(backend);

    await updateExistingAgentLLMConfig(currentAgent, "custom/hosted-claude", {
      reasoning_effort: "high",
    });

    expect(calls[0]?.body.model_settings).toMatchObject({
      provider_type: "anthropic",
      effort: "high",
      temperature: 0.2,
    });
  });

  test("falls back to safe preset limits when the backend catalog is unavailable", async () => {
    const currentAgent = makeAgent({
      llm_config: {
        model: "claude-sonnet-5",
        model_endpoint_type: "anthropic",
        context_window: 500_000,
        max_tokens: 256_000,
      },
    });
    const { backend, calls } = makeBackend({
      agent: currentAgent,
      listModelsError: new Error("catalog unavailable"),
    });
    __testSetBackend(backend);

    const result = await updateExistingAgentLLMConfig(
      currentAgent,
      "openai/gpt-5.6-sol",
      { context_window: 350_000, max_output_tokens: 128_000 },
    );

    expect(calls[0]?.body.context_window_limit).toBe(350_000);
    expect(calls[0]?.body.max_tokens).toBe(128_000);
    expect(result.warnings).toEqual([
      "Could not load backend limits for openai/gpt-5.6-sol (catalog unavailable); using preset limits and backend validation.",
      "Clamped preserved context_window_limit from 500000 to 350000 for the selected model.",
      "Clamped preserved max_tokens from 256000 to 128000 for the selected model.",
    ]);
  });

  test("uses the selected output default when max tokens are absent from the agent", async () => {
    const currentAgent = makeAgent({
      llm_config: {
        model: "claude-sonnet-5",
        model_endpoint_type: "anthropic",
        context_window: 65_536,
      },
      model_settings: {
        provider_type: "anthropic",
        temperature: 0.3,
      },
    });
    const { backend, calls } = makeBackend({ agent: currentAgent });
    __testSetBackend(backend);

    await updateExistingAgentLLMConfig(currentAgent, "openai/gpt-5.6-sol", {
      context_window: 350_000,
      max_output_tokens: 128_000,
    });

    expect(calls[0]?.body).toMatchObject({
      context_window_limit: 65_536,
      max_tokens: 128_000,
      model_settings: { temperature: 0.3 },
    });
  });

  test("ordinary preset updates still apply complete defaults", async () => {
    const { backend, calls } = makeBackend();
    __testSetBackend(backend);

    await updateAgentLLMConfig("agent-1", "openai/gpt-5.6-sol", {
      context_window: 350_000,
      max_output_tokens: 128_000,
      reasoning_effort: "high",
      parallel_tool_calls: true,
    });

    expect(calls[0]?.body).toMatchObject({
      model: "openai/gpt-5.6-sol",
      context_window_limit: 350_000,
      max_tokens: 128_000,
      model_settings: {
        provider_type: "openai",
        reasoning: { reasoning_effort: "high" },
        max_output_tokens: 128_000,
      },
    });
  });
});
