import { describe, expect, mock, test } from "bun:test";
import type {
  AgentState,
  AgentUpdateParams,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { Tool } from "@letta-ai/letta-client/resources/tools";
import {
  DEFAULT_ATTACHED_BASE_TOOLS,
  reconcileExistingAgentState,
} from "../../agent/reconcileExistingAgentState";

function mkTool(id: string, name: string): Tool {
  return { id, name } as Tool;
}

function mkAgentState(overrides: Partial<AgentState>): AgentState {
  return {
    id: "agent-test",
    tools: [],
    name: "test-agent",
    system: "system",
    agent_type: "letta_v1_agent",
    blocks: [],
    llm_config: {} as AgentState["llm_config"],
    memory: { blocks: [] } as AgentState["memory"],
    sources: [],
    tags: [],
    ...overrides,
  } as AgentState;
}

describe("reconcileExistingAgentState", () => {
  test("does not update when compaction model and attached tools are already correct", async () => {
    const agent = mkAgentState({
      tools: [
        mkTool("tool-web", "web_search"),
        mkTool("tool-fetch", "fetch_webpage"),
      ],
      compaction_settings: {
        model: "letta/auto",
      },
    });

    const update = mock(() => Promise.resolve(agent));
    const list = mock(() => Promise.resolve({ items: [] as Tool[] }));

    const result = await reconcileExistingAgentState(
      {
        agents: { update },
        tools: { list },
      },
      agent,
    );

    expect(result.updated).toBe(false);
    expect(result.appliedTweaks).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  test("adds missing base tool while preserving existing non-base tools", async () => {
    const initialAgent = mkAgentState({
      tools: [
        mkTool("tool-web", "web_search"),
        mkTool("tool-convo", "conversation_search"),
      ],
      compaction_settings: {
        mode: "sliding_window",
        model: "",
      },
    });

    const updatedAgent = mkAgentState({
      tools: [
        mkTool("tool-web", "web_search"),
        mkTool("tool-convo", "conversation_search"),
        mkTool("tool-fetch", "fetch_webpage"),
      ],
      compaction_settings: {
        mode: "sliding_window",
        model: "letta/auto",
      },
    });

    const update = mock((_agentID: string, _body: AgentUpdateParams) =>
      Promise.resolve(updatedAgent),
    );
    const list = mock((query?: { name?: string | null }) => {
      if (query?.name === "fetch_webpage") {
        return Promise.resolve({
          items: [mkTool("tool-fetch", "fetch_webpage")],
        });
      }
      return Promise.resolve({ items: [] as Tool[] });
    });

    const result = await reconcileExistingAgentState(
      {
        agents: { update },
        tools: { list },
      },
      initialAgent,
    );

    expect(result.updated).toBe(true);
    expect(result.appliedTweaks).toEqual([
      "set_compaction_model",
      "sync_attached_tools",
    ]);
    expect(result.agent).toBe(updatedAgent);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ name: "fetch_webpage", limit: 10 });

    // Must preserve existing tools and only append the missing base tool
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("agent-test", {
      compaction_settings: {
        mode: "sliding_window",
        model: "letta/auto",
      },
      tool_ids: ["tool-web", "tool-convo", "tool-fetch"],
    });

    expect(DEFAULT_ATTACHED_BASE_TOOLS).toEqual([
      "web_search",
      "fetch_webpage",
    ]);
  });

  test("does not update tools when base tools are already present alongside extra tools", async () => {
    const agent = mkAgentState({
      tools: [
        mkTool("tool-web", "web_search"),
        mkTool("tool-fetch", "fetch_webpage"),
        mkTool("tool-memory", "memory"),
        mkTool("tool-mcp", "custom_mcp_tool"),
      ],
      compaction_settings: {
        model: "letta/auto",
      },
    });

    const update = mock(() => Promise.resolve(agent));
    const list = mock(() => Promise.resolve({ items: [] as Tool[] }));

    const result = await reconcileExistingAgentState(
      {
        agents: { update },
        tools: { list },
      },
      agent,
    );

    expect(result.updated).toBe(false);
    expect(result.appliedTweaks).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });
});
