import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Letta } from "@letta-ai/letta-client";
import { linkToolsToAgent, unlinkToolsFromAgent } from "../../agent/modify";
import { settingsManager } from "../../settings-manager";
import { getToolNames, loadTools } from "../../tools/manager";

// Skip these integration tests if LETTA_API_KEY is not set
const shouldSkip = !process.env.LETTA_API_KEY;
const describeOrSkip = shouldSkip ? describe.skip : describe;

describeOrSkip("Link/Unlink Tools", () => {
  let client: Letta;
  let testAgentId: string;

  beforeAll(async () => {
    // Initialize settings and load tools
    await settingsManager.initialize();
    await loadTools();

    // Create a test agent
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey) {
      throw new Error("LETTA_API_KEY required for tests");
    }

    client = new Letta({ apiKey });

    const agent = await client.agents.create({
      model: "openai/gpt-4o-mini",
      embedding: "openai/text-embedding-3-small",
      memory_blocks: [
        { label: "human", value: "Test user" },
        { label: "persona", value: "Test agent" },
      ],
      tools: [],
    });

    testAgentId = agent.id;
  });

  afterAll(async () => {
    // Cleanup: delete test agent
    if (testAgentId) {
      try {
        await client.agents.delete(testAgentId);
      } catch (_error) {
        // Ignore cleanup errors
      }
    }
  });

  test("linkToolsToAgent attaches all Letta Code tools", async () => {
    // Reset: ensure tools are not already attached
    await unlinkToolsFromAgent(testAgentId);

    const result = await linkToolsToAgent(testAgentId);

    expect(result.success).toBe(true);
    expect(result.addedCount).toBeGreaterThan(0);

    // Verify tools were attached
    const agent = await client.agents.retrieve(testAgentId);
    const toolNames = agent.tools?.map((t) => t.name) || [];
    const lettaCodeTools = getToolNames();

    for (const toolName of lettaCodeTools) {
      expect(toolNames).toContain(toolName);
    }
  }, 30000);

  test("linkToolsToAgent adds approval rules for all tools", async () => {
    // First unlink to reset
    await unlinkToolsFromAgent(testAgentId);

    // Link tools
    await linkToolsToAgent(testAgentId);

    // Verify approval rules were added
    const agent = await client.agents.retrieve(testAgentId);
    const approvalRules = agent.tool_rules?.filter(
      (rule) => rule.type === "requires_approval",
    );

    const lettaCodeTools = getToolNames();
    expect(approvalRules?.length).toBe(lettaCodeTools.length);

    // Check all Letta Code tools have approval rules
    const rulesToolNames = approvalRules?.map((r) => r.tool_name) || [];
    for (const toolName of lettaCodeTools) {
      expect(rulesToolNames).toContain(toolName);
    }
  }, 30000);

  test("linkToolsToAgent returns success when tools already attached", async () => {
    // Reset and link once
    await unlinkToolsFromAgent(testAgentId);
    await linkToolsToAgent(testAgentId);

    // Link again
    const result = await linkToolsToAgent(testAgentId);

    expect(result.success).toBe(true);
    expect(result.addedCount).toBe(0);
    expect(result.message).toContain("already attached");
  }, 30000);

  test("unlinkToolsFromAgent removes all Letta Code tools", async () => {
    // First link tools
    await linkToolsToAgent(testAgentId);

    // Then unlink
    const result = await unlinkToolsFromAgent(testAgentId);

    expect(result.success).toBe(true);
    expect(result.removedCount).toBeGreaterThan(0);

    // Verify tools were removed
    const agent = await client.agents.retrieve(testAgentId);
    const toolNames = agent.tools?.map((t) => t.name) || [];
    const lettaCodeTools = getToolNames();

    for (const toolName of lettaCodeTools) {
      expect(toolNames).not.toContain(toolName);
    }
  }, 30000);

  test("unlinkToolsFromAgent removes approval rules", async () => {
    // First link tools
    await linkToolsToAgent(testAgentId);

    // Then unlink
    await unlinkToolsFromAgent(testAgentId);

    // Verify approval rules were removed
    const agent = await client.agents.retrieve(testAgentId);
    const approvalRules = agent.tool_rules?.filter(
      (rule) => rule.type === "requires_approval",
    );

    const lettaCodeTools = new Set(getToolNames());
    const remainingApprovalRules = approvalRules?.filter((r) =>
      lettaCodeTools.has(r.tool_name),
    );

    expect(remainingApprovalRules?.length || 0).toBe(0);
  }, 30000);

  test("unlinkToolsFromAgent preserves non-Letta-Code tools", async () => {
    // Link Letta Code tools
    await linkToolsToAgent(testAgentId);

    // Attach memory tool
    const memoryTools = await client.tools.list({ name: "memory" });
    const memoryTool = memoryTools[0];
    if (memoryTool?.id) {
      await client.agents.tools.attach(memoryTool.id, {
        agent_id: testAgentId,
      });
    }

    // Unlink Letta Code tools
    await unlinkToolsFromAgent(testAgentId);

    // Verify memory tool is still there
    const agent = await client.agents.retrieve(testAgentId);
    const toolNames = agent.tools?.map((t) => t.name) || [];

    expect(toolNames).toContain("memory");

    // Verify Letta Code tools are gone
    const lettaCodeTools = getToolNames();
    for (const toolName of lettaCodeTools) {
      expect(toolNames).not.toContain(toolName);
    }
  }, 30000);

  test("unlinkToolsFromAgent preserves non-approval tool_rules", async () => {
    // Link tools
    await linkToolsToAgent(testAgentId);

    // Add a continue_loop rule manually
    const agent = await client.agents.retrieve(testAgentId);
    const newToolRules = [
      ...(agent.tool_rules || []),
      {
        tool_name: "memory",
        type: "continue_loop" as const,
        prompt_template: "Test rule",
      },
    ];

    await client.agents.modify(testAgentId, { tool_rules: newToolRules });

    // Unlink Letta Code tools
    await unlinkToolsFromAgent(testAgentId);

    // Verify continue_loop rule is still there
    const updatedAgent = await client.agents.retrieve(testAgentId);
    const continueLoopRules = updatedAgent.tool_rules?.filter(
      (r) => r.type === "continue_loop" && r.tool_name === "memory",
    );

    expect(continueLoopRules?.length).toBe(1);
  }, 30000);
});
