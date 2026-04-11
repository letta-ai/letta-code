import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockAgentsRetrieve = mock();
const mockAgentsUpdate = mock();
const mockGetModelContextWindow = mock();
const mockGetServerUrl = mock();

mock.module("../../agent/client", () => ({
  getClient: async () => ({
    agents: {
      retrieve: mockAgentsRetrieve,
      update: mockAgentsUpdate,
    },
  }),
  getServerUrl: mockGetServerUrl,
}));

mock.module("../../agent/available-models", () => ({
  getModelContextWindow: mockGetModelContextWindow,
}));

mock.module("../../providers/openai-codex-provider", () => ({
  OPENAI_CODEX_PROVIDER_NAME: "chatgpt-plus-pro",
}));

describe("updateAgentLLMConfig", () => {
  beforeEach(() => {
    mockAgentsRetrieve.mockReset();
    mockAgentsUpdate.mockReset();
    mockGetModelContextWindow.mockReset();
    mockGetServerUrl.mockReset();
  });

  test("preserves self-hosted Ollama endpoints when switching Ollama models", async () => {
    mockGetServerUrl.mockReturnValue("http://localhost:8283");
    mockGetModelContextWindow.mockResolvedValue(32000);

    const currentAgent = {
      llm_config: {
        context_window: 128000,
        model: "kimi-k2.5:cloud",
        model_endpoint_type: "openai",
        model_endpoint: "http://host.docker.internal:11434/v1",
        provider_name: "ollama",
        provider_category: "base",
        model_wrapper: null,
        handle: "ollama/kimi-k2.5:cloud",
        temperature: 0.7,
        max_tokens: 16384,
        enable_reasoner: true,
        reasoning_effort: "high",
        max_reasoning_tokens: 0,
        effort: null,
        frequency_penalty: null,
        compatibility_type: null,
        verbosity: null,
        tier: null,
        parallel_tool_calls: true,
        response_format: null,
        put_inner_thoughts_in_kwargs: false,
      },
      embedding_config: {
        embedding_dim: 4096,
        embedding_endpoint_type: "openai",
        embedding_model: "qwen3-embedding:8b-q8_0",
        embedding_chunk_size: 300,
        embedding_endpoint: "http://host.docker.internal:11434/v1",
        handle: "ollama/qwen3-embedding:8b-q8_0",
        batch_size: 32,
        azure_endpoint: null,
        azure_version: null,
        azure_deployment: null,
      },
    };

    const finalAgent = {
      id: "agent-1",
      ...currentAgent,
    };

    mockAgentsRetrieve
      .mockResolvedValueOnce(currentAgent)
      .mockResolvedValueOnce(finalAgent);
    mockAgentsUpdate.mockResolvedValue(finalAgent);

    const { updateAgentLLMConfig } = await import("../../agent/modify");
    const result = await updateAgentLLMConfig(
      "agent-1",
      "ollama/glm-5:cloud",
    );

    expect(result).toBe(finalAgent);
    expect(mockAgentsUpdate).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        model: "ollama/glm-5:cloud",
        llm_config: expect.objectContaining({
          model: "glm-5:cloud",
          handle: "ollama/glm-5:cloud",
          model_endpoint: "http://host.docker.internal:11434/v1",
        }),
        embedding_config: expect.objectContaining({
          embedding_endpoint: "http://host.docker.internal:11434/v1",
        }),
      }),
    );
  });

  test("keeps cloud updates minimal", async () => {
    mockGetServerUrl.mockReturnValue("https://api.letta.com");
    mockGetModelContextWindow.mockResolvedValue(128000);

    const finalAgent = {
      id: "agent-1",
      llm_config: {
        context_window: 128000,
        model: "kimi-k2.5:cloud",
        model_endpoint_type: "openai",
        model_endpoint: "http://host.docker.internal:11434/v1",
        provider_name: "ollama",
        handle: "ollama/kimi-k2.5:cloud",
      },
      embedding_config: {
        embedding_dim: 4096,
        embedding_endpoint_type: "openai",
        embedding_model: "qwen3-embedding:8b-q8_0",
        embedding_endpoint: "http://host.docker.internal:11434/v1",
      },
    };

    mockAgentsRetrieve.mockResolvedValueOnce(finalAgent);
    mockAgentsUpdate.mockResolvedValue({});

    const { updateAgentLLMConfig } = await import("../../agent/modify");
    await updateAgentLLMConfig(
      "agent-1",
      "anthropic/claude-sonnet-4-5-20250929",
    );

    expect(mockAgentsUpdate).toHaveBeenCalledWith(
      "agent-1",
      expect.not.objectContaining({
        llm_config: expect.anything(),
        embedding_config: expect.anything(),
      }),
    );
    expect(mockAgentsUpdate).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4-5-20250929",
      }),
    );
    expect(mockAgentsRetrieve).toHaveBeenCalledTimes(1);
  });
});
