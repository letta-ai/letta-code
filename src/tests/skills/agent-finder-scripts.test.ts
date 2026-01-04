/**
 * Tests for the bundled agent-finder scripts
 */

import { describe, expect, mock, test } from "bun:test";
import type Letta from "@letta-ai/letta-client";
import { findAgents } from "../../skills/builtin/agent-finder/scripts/find-agents";

// Mock data
const mockAgentsResponse = [
  { id: "agent-123", name: "Test Agent 1", tags: ["origin:letta-code"] },
  { id: "agent-456", name: "Test Agent 2", tags: ["frontend"] },
];

describe("find-agents", () => {
  test("calls client.agents.list with default options", async () => {
    const mockList = mock(() => Promise.resolve(mockAgentsResponse));
    const mockClient = {
      agents: {
        list: mockList,
      },
    } as unknown as Letta;

    const result = await findAgents(mockClient);

    expect(mockList).toHaveBeenCalledWith({ limit: 20 });
    expect(result).toBeDefined();
  });

  test("passes name filter", async () => {
    const mockList = mock(() => Promise.resolve(mockAgentsResponse));
    const mockClient = {
      agents: {
        list: mockList,
      },
    } as unknown as Letta;

    await findAgents(mockClient, { name: "Test Agent" });

    expect(mockList).toHaveBeenCalledWith({
      limit: 20,
      name: "Test Agent",
    });
  });

  test("passes query_text for fuzzy search", async () => {
    const mockList = mock(() => Promise.resolve(mockAgentsResponse));
    const mockClient = {
      agents: {
        list: mockList,
      },
    } as unknown as Letta;

    await findAgents(mockClient, { query: "test" });

    expect(mockList).toHaveBeenCalledWith({
      limit: 20,
      query_text: "test",
    });
  });

  test("passes tags filter", async () => {
    const mockList = mock(() => Promise.resolve(mockAgentsResponse));
    const mockClient = {
      agents: {
        list: mockList,
      },
    } as unknown as Letta;

    await findAgents(mockClient, { tags: ["origin:letta-code", "frontend"] });

    expect(mockList).toHaveBeenCalledWith({
      limit: 20,
      tags: ["origin:letta-code", "frontend"],
    });
  });

  test("passes match_all_tags when specified", async () => {
    const mockList = mock(() => Promise.resolve(mockAgentsResponse));
    const mockClient = {
      agents: {
        list: mockList,
      },
    } as unknown as Letta;

    await findAgents(mockClient, {
      tags: ["origin:letta-code", "frontend"],
      matchAllTags: true,
    });

    expect(mockList).toHaveBeenCalledWith({
      limit: 20,
      tags: ["origin:letta-code", "frontend"],
      match_all_tags: true,
    });
  });

  test("includes agent.blocks when specified", async () => {
    const mockList = mock(() => Promise.resolve(mockAgentsResponse));
    const mockClient = {
      agents: {
        list: mockList,
      },
    } as unknown as Letta;

    await findAgents(mockClient, { includeBlocks: true });

    expect(mockList).toHaveBeenCalledWith({
      limit: 20,
      include: ["agent.blocks"],
    });
  });

  test("respects custom limit", async () => {
    const mockList = mock(() => Promise.resolve(mockAgentsResponse));
    const mockClient = {
      agents: {
        list: mockList,
      },
    } as unknown as Letta;

    await findAgents(mockClient, { limit: 5 });

    expect(mockList).toHaveBeenCalledWith({ limit: 5 });
  });

  test("handles empty results", async () => {
    const mockClient = {
      agents: {
        list: mock(() => Promise.resolve([])),
      },
    } as unknown as Letta;

    const result = await findAgents(mockClient);
    expect(result).toBeDefined();
  });

  test("propagates API errors", async () => {
    const mockClient = {
      agents: {
        list: mock(() => Promise.reject(new Error("API Error"))),
      },
    } as unknown as Letta;

    await expect(findAgents(mockClient)).rejects.toThrow("API Error");
  });
});
