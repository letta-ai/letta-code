/**
 * Tests for the bundled memory-migration scripts
 */

import { describe, expect, mock, test } from "bun:test";
import type Letta from "@letta-ai/letta-client";
import { attachBlock } from "../../skills/builtin/migrating-memory/scripts/attach-block";
import { copyBlock } from "../../skills/builtin/migrating-memory/scripts/copy-block";
import { getAgentBlocks } from "../../skills/builtin/migrating-memory/scripts/get-agent-blocks";
import { listAgents } from "../../skills/builtin/migrating-memory/scripts/list-agents";

// Mock data
const mockAgentsResponse = [
  { id: "agent-123", name: "Test Agent 1" },
  { id: "agent-456", name: "Test Agent 2" },
];

const mockBlocksResponse = [
  {
    id: "block-abc",
    label: "project",
    description: "Project info",
    value: "Test project content",
  },
  {
    id: "block-def",
    label: "human",
    description: "Human preferences",
    value: "Test human content",
  },
];

const mockBlock = {
  id: "block-abc",
  label: "project",
  description: "Project info",
  value: "Test project content",
  limit: 5000,
};

const mockNewBlock = {
  id: "block-new-123",
  label: "project",
  description: "Project info",
  value: "Test project content",
  limit: 5000,
};

const mockAgentState = {
  id: "agent-789",
  name: "Target Agent",
  agent_type: "memgpt_agent",
  blocks: [],
  llm_config: {},
  memory: {},
  embedding_config: {},
  project_id: "project-123",
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
};

describe("list-agents", () => {
  test("calls client.agents.list and returns result", async () => {
    const mockList = mock(() => Promise.resolve(mockAgentsResponse));
    const mockClient = {
      agents: {
        list: mockList,
      },
    } as unknown as Letta;

    const result = await listAgents(mockClient);
    expect(mockList).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  test("handles empty agent list", async () => {
    const mockClient = {
      agents: {
        list: mock(() => Promise.resolve([])),
      },
    } as unknown as Letta;

    const result = await listAgents(mockClient);
    expect(result).toBeDefined();
  });

  test("propagates API errors", async () => {
    const mockClient = {
      agents: {
        list: mock(() => Promise.reject(new Error("API Error"))),
      },
    } as unknown as Letta;

    await expect(listAgents(mockClient)).rejects.toThrow("API Error");
  });
});

describe("get-agent-blocks", () => {
  test("calls client.agents.blocks.list with agent ID", async () => {
    const mockList = mock(() => Promise.resolve(mockBlocksResponse));
    const mockClient = {
      agents: {
        blocks: {
          list: mockList,
        },
      },
    } as unknown as Letta;

    const result = await getAgentBlocks(mockClient, "agent-123");
    expect(mockList).toHaveBeenCalledWith("agent-123");
    expect(result).toBeDefined();
  });

  test("handles agent with no blocks", async () => {
    const mockClient = {
      agents: {
        blocks: {
          list: mock(() => Promise.resolve([])),
        },
      },
    } as unknown as Letta;

    const result = await getAgentBlocks(mockClient, "agent-empty");
    expect(result).toBeDefined();
  });

  test("propagates API errors", async () => {
    const mockClient = {
      agents: {
        blocks: {
          list: mock(() => Promise.reject(new Error("Agent not found"))),
        },
      },
    } as unknown as Letta;

    await expect(getAgentBlocks(mockClient, "nonexistent")).rejects.toThrow(
      "Agent not found",
    );
  });
});

describe("copy-block", () => {
  test("retrieves source block, creates new block, and attaches to target agent", async () => {
    const mockRetrieve = mock(() => Promise.resolve(mockBlock));
    const mockCreate = mock(() => Promise.resolve(mockNewBlock));
    const mockAttach = mock(() => Promise.resolve(mockAgentState));

    const mockClient = {
      blocks: {
        retrieve: mockRetrieve,
        create: mockCreate,
      },
      agents: {
        blocks: {
          attach: mockAttach,
        },
      },
    } as unknown as Letta;

    // Pass explicit agent ID for testing (in production, defaults to current agent)
    const result = await copyBlock(mockClient, "block-abc", "agent-789");

    expect(mockRetrieve).toHaveBeenCalledWith("block-abc");
    expect(mockCreate).toHaveBeenCalledWith({
      label: "project",
      value: "Test project content",
      description: "Project info",
      limit: 5000,
    });
    expect(mockAttach).toHaveBeenCalledWith("block-new-123", {
      agent_id: "agent-789",
    });

    expect(result.sourceBlock).toEqual(mockBlock);
    expect(result.newBlock).toEqual(mockNewBlock);
    expect(result.attachResult).toBeDefined();
  });

  test("handles block without description", async () => {
    const blockWithoutDesc = { ...mockBlock, description: null };
    const mockClient = {
      blocks: {
        retrieve: mock(() => Promise.resolve(blockWithoutDesc)),
        create: mock(() => Promise.resolve(mockNewBlock)),
      },
      agents: {
        blocks: {
          attach: mock(() => Promise.resolve(mockAgentState)),
        },
      },
    } as unknown as Letta;

    const result = await copyBlock(mockClient, "block-abc", "agent-789");
    expect(result.newBlock).toBeDefined();
  });

  test("propagates errors from retrieve", async () => {
    const mockClient = {
      blocks: {
        retrieve: mock(() => Promise.reject(new Error("Block not found"))),
        create: mock(() => Promise.resolve(mockNewBlock)),
      },
      agents: {
        blocks: {
          attach: mock(() => Promise.resolve(mockAgentState)),
        },
      },
    } as unknown as Letta;

    await expect(
      copyBlock(mockClient, "nonexistent", "agent-789"),
    ).rejects.toThrow("Block not found");
  });
});

describe("attach-block", () => {
  test("attaches existing block to target agent", async () => {
    const mockAttach = mock(() => Promise.resolve(mockAgentState));
    const mockClient = {
      agents: {
        blocks: {
          attach: mockAttach,
        },
      },
    } as unknown as Letta;

    // Pass explicit agent ID for testing (in production, defaults to current agent)
    const result = await attachBlock(
      mockClient,
      "block-abc",
      false,
      "agent-789",
    );

    expect(mockAttach).toHaveBeenCalledWith("block-abc", {
      agent_id: "agent-789",
    });
    expect(result).toBeDefined();
  });

  test("handles read-only flag without error", async () => {
    const mockClient = {
      agents: {
        blocks: {
          attach: mock(() => Promise.resolve(mockAgentState)),
        },
      },
    } as unknown as Letta;

    // The function should work with read-only flag (currently just warns)
    const result = await attachBlock(
      mockClient,
      "block-abc",
      true,
      "agent-789",
    );
    expect(result).toBeDefined();
  });

  test("propagates API errors", async () => {
    const mockClient = {
      agents: {
        blocks: {
          attach: mock(() => Promise.reject(new Error("Cannot attach block"))),
        },
      },
    } as unknown as Letta;

    await expect(
      attachBlock(mockClient, "block-abc", false, "agent-789"),
    ).rejects.toThrow("Cannot attach block");
  });
});
