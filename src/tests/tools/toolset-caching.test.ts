import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";

const retrieveAgent = mock(async () => ({
  id: "agent-1",
  name: "Ada",
  description: "Agent description",
  system: "You are Ada.",
  model: "anthropic/claude-sonnet-4",
  llm_config: null,
}));
const retrieveConversation = mock(async () => ({
  id: "conversation-1",
  model: "google_ai/gemini-2.5-pro",
}));

const prepareToolExecutionContextForModel = mock(async () => ({
  contextId: "ctx-1",
  clientTools: [],
  loadedToolNames: ["Bash"],
}));
const prepareToolExecutionContextForSpecificTools = mock(async () => ({
  contextId: "ctx-2",
  clientTools: [],
  loadedToolNames: ["Bash"],
}));
const getToolsetPreference = mock(() => "auto" as const);
const getChannelRegistry = mock(() => null);

mock.module("../../backend", () => ({
  getBackend: () => ({
    retrieveAgent,
    retrieveConversation,
  }),
}));

mock.module("../../settings-manager", () => ({
  settingsManager: {
    getToolsetPreference,
  },
}));

mock.module("../../channels/registry", () => ({
  getChannelRegistry,
}));

mock.module("../../tools/manager", () => ({
  ANTHROPIC_DEFAULT_TOOLS: [],
  clearToolsWithLock: mock(() => {}),
  filterBuiltInToolNamesByClientAllowlist: (toolNames: string[]) => toolNames,
  GEMINI_DEFAULT_TOOLS: [],
  GEMINI_PASCAL_TOOLS: [],
  getToolNames: () => [],
  isOpenAIModel: () => false,
  loadSpecificTools: mock(async () => {}),
  loadTools: mock(async () => {}),
  OPENAI_DEFAULT_TOOLS: [],
  OPENAI_PASCAL_TOOLS: [],
  prepareToolExecutionContextForModel,
  prepareToolExecutionContextForSpecificTools,
}));

describe("prepareToolExecutionContextForScope caching", () => {
  beforeEach(() => {
    retrieveAgent.mockReset();
    retrieveAgent.mockResolvedValue({
      id: "agent-1",
      name: "Ada",
      description: "Agent description",
      system: "You are Ada.",
      model: "anthropic/claude-sonnet-4",
      llm_config: null,
    });
    retrieveConversation.mockReset();
    retrieveConversation.mockResolvedValue({
      id: "conversation-1",
      model: "google_ai/gemini-2.5-pro",
    });
    prepareToolExecutionContextForModel.mockReset();
    prepareToolExecutionContextForModel.mockResolvedValue({
      contextId: "ctx-1",
      clientTools: [],
      loadedToolNames: ["Bash"],
    });
    prepareToolExecutionContextForSpecificTools.mockReset();
    prepareToolExecutionContextForSpecificTools.mockResolvedValue({
      contextId: "ctx-2",
      clientTools: [],
      loadedToolNames: ["Bash"],
    });
    getToolsetPreference.mockReset();
    getToolsetPreference.mockReturnValue("auto");
    getChannelRegistry.mockReset();
    getChannelRegistry.mockReturnValue(null);
  });

  afterAll(() => {
    mock.restore();
  });

  test("reuses a cached agent snapshot and skips the agent fetch", async () => {
    const cachedAgent = {
      id: "agent-1",
      name: "Ada",
      description: "Agent description",
      system: "You are Ada.",
      model: "anthropic/claude-sonnet-4",
      llm_config: null,
    } as AgentState;

    const { prepareToolExecutionContextForScope } = await import(
      "../../tools/toolset",
    );

    const result = await prepareToolExecutionContextForScope({
      agentId: "agent-1",
      conversationId: "conversation-1",
      cachedAgent,
      cachedEffectiveModel: "anthropic/claude-sonnet-4",
      workingDirectory: "/tmp/project",
    });

    expect(retrieveAgent).not.toHaveBeenCalled();
    expect(retrieveConversation).not.toHaveBeenCalled();
    expect(prepareToolExecutionContextForModel).toHaveBeenCalledTimes(1);
    expect(prepareToolExecutionContextForModel).toHaveBeenCalledWith(
      "anthropic/claude-sonnet-4",
      expect.objectContaining({
        workingDirectory: "/tmp/project",
      }),
    );
    expect(result.agent).toBe(cachedAgent);
  });

  test("uses a cached conversation model to skip conversation retrieval", async () => {
    const cachedAgent = {
      id: "agent-1",
      name: "Ada",
      description: "Agent description",
      system: "You are Ada.",
      model: "anthropic/claude-sonnet-4",
      llm_config: null,
    } as AgentState;

    const { prepareToolExecutionContextForScope } = await import(
      "../../tools/toolset",
    );

    await prepareToolExecutionContextForScope({
      agentId: "agent-1",
      conversationId: "conversation-1",
      cachedAgent,
      cachedEffectiveModel: "google_ai/gemini-2.5-pro",
      workingDirectory: "/tmp/project",
    });

    expect(retrieveAgent).not.toHaveBeenCalled();
    expect(retrieveConversation).not.toHaveBeenCalled();
    expect(prepareToolExecutionContextForModel).toHaveBeenCalledWith(
      "google_ai/gemini-2.5-pro",
      expect.objectContaining({
        workingDirectory: "/tmp/project",
      }),
    );
  });

  test("listener turn passes the cached agent snapshot into tool prep", () => {
    const turnPath = fileURLToPath(
      new URL("../../websocket/listener/turn.ts", import.meta.url),
    );
    const source = readFileSync(turnPath, "utf-8");

    expect(source).toContain("cachedAgent: AgentState | null = null;");
    expect(source).toContain("buildMaybeLaunchReflectionSubagent({");
    expect(source).toContain("prepareToolExecutionContextForScope({");
    expect(source).toContain("cachedAgent,");
  });
});
