import { describe, expect, mock, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Backend } from "@/backend/backend";
import {
  resolveSkillsAgentById,
  resolveSkillsAgentByName,
} from "./skills-agent-resolver";

type AgentLookupBackend = Pick<Backend, "listAgents" | "retrieveAgent">;

function agent(id: string, name: string): AgentState {
  return { id, name } as AgentState;
}

describe("skills agent resolver", () => {
  test("uses point retrieval for an exact agent id without listing agents", async () => {
    const retrieveAgent = mock(async () => agent("agent-123", "Target"));
    const listAgents = mock(async () => {
      throw new Error("listAgents should not be called");
    });
    const backend = { listAgents, retrieveAgent } as AgentLookupBackend;

    await expect(resolveSkillsAgentById("agent-123", backend)).resolves.toBe(
      "agent-123",
    );

    expect(retrieveAgent).toHaveBeenCalledTimes(1);
    expect(retrieveAgent).toHaveBeenCalledWith("agent-123");
    expect(listAgents).toHaveBeenCalledTimes(0);
  });

  test("preserves point-retrieval permission and not-found errors", async () => {
    const retrievalError = new Error("Agent not found or access denied");
    const retrieveAgent = mock(async () => {
      throw retrievalError;
    });
    const listAgents = mock(async () => {
      throw new Error("listAgents should not be called");
    });
    const backend = { listAgents, retrieveAgent } as AgentLookupBackend;

    await expect(resolveSkillsAgentById("agent-missing", backend)).rejects.toBe(
      retrievalError,
    );

    expect(listAgents).toHaveBeenCalledTimes(0);
  });

  test("keeps mixed-case duplicate ambiguity complete across API pages", async () => {
    const firstPageAgents = [
      agent("agent-first", "Target"),
      ...Array.from({ length: 99 }, (_, index) =>
        agent(`agent-unrelated-${index}`, `Unrelated ${index}`),
      ),
    ];
    const secondPage = {
      items: [agent("agent-second", "TARGET")],
      hasNextPage: () => false,
    };
    const firstPage = {
      items: firstPageAgents,
      hasNextPage: () => true,
      getNextPage: mock(async () => secondPage),
    };
    const listAgents = mock(async (params?: { query_text?: string | null }) => {
      if (!params?.query_text) return { items: [] };
      return firstPage;
    });
    const backend = {
      listAgents,
      retrieveAgent: mock(async () => agent("unused", "Unused")),
    } as unknown as AgentLookupBackend;

    await expect(resolveSkillsAgentByName("target", backend)).rejects.toThrow(
      'Multiple agents found with name "target". Pass --agent with an agent id instead.',
    );

    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(listAgents).toHaveBeenCalledWith({
      query_text: "target",
      limit: 100,
    });
    expect(firstPage.getNextPage).toHaveBeenCalledTimes(1);
  });

  test("finds a mixed-case exact name on a later plain-object page", async () => {
    const firstPageAgents = Array.from({ length: 100 }, (_, index) =>
      agent(`agent-unrelated-${index}`, `Unrelated ${index}`),
    );
    const listAgents = mock(
      async (params?: {
        after?: string | null;
        query_text?: string | null;
      }) => {
        if (!params?.query_text) return { items: [] };
        if (params.after) {
          return { items: [agent("agent-target", "Target")] };
        }
        return { items: firstPageAgents };
      },
    );
    const backend = {
      listAgents,
      retrieveAgent: mock(async () => agent("unused", "Unused")),
    } as unknown as AgentLookupBackend;

    await expect(resolveSkillsAgentByName("target", backend)).resolves.toBe(
      "agent-target",
    );

    expect(listAgents).toHaveBeenCalledTimes(2);
    expect(listAgents).toHaveBeenNthCalledWith(1, {
      query_text: "target",
      limit: 100,
    });
    expect(listAgents).toHaveBeenNthCalledWith(2, {
      query_text: "target",
      limit: 100,
      after: "agent-unrelated-99",
    });
  });
});
