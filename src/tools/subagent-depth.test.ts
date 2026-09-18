import { afterEach, describe, expect, test } from "bun:test";
import { getAllSubagentConfigs } from "@/agent/subagents";
import { spawnSubagent } from "@/agent/subagents/manager";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  getRuntimeExecutionEnv,
  type RuntimeExecutionSettings,
} from "@/runtime-execution-settings";
import { task } from "./impl/task";
import {
  executeTool,
  loadSpecificTools,
  prepareToolExecutionContextForSpecificTools,
} from "./manager";

function settings(depth: number): RuntimeExecutionSettings {
  return {
    subagent_depth: depth,
    agent_role: depth > 0 ? "subagent" : undefined,
    allowed_tools: [],
    disallowed_tools: ["Write"],
    disable_memory_guard: false,
  };
}

describe("bounded subagent delegation", () => {
  afterEach(async () => {
    await loadSpecificTools([]);
  });
  test("depth one advertises Agent, depth two hides it without changing other tools", async () => {
    const configs = await getAllSubagentConfigs();
    const tools = configs["general-purpose"]?.allowedTools as string[];
    expect(tools).toContain("Agent");
    for (const depth of [0, 1, 2]) {
      const prepared = await prepareToolExecutionContextForSpecificTools(
        tools,
        {
          runtimeContext: { executionSettings: settings(depth) },
        },
      );
      expect(prepared.loadedToolNames.includes("Agent")).toBe(depth < 2);
      expect(prepared.loadedToolNames).toContain("Read");
      expect(prepared.loadedToolNames).not.toContain("SendAgentMessage");
      if (depth === 2) {
        const result = await executeTool(
          "Agent",
          {},
          { toolContextId: prepared.contextId },
        );
        expect(result.status).toBe("error");
      }
    }
    const restricted = await prepareToolExecutionContextForSpecificTools(
      ["Agent", "Read"],
      {
        clientToolAllowlist: ["Read"],
        runtimeContext: { executionSettings: settings(1) },
      },
    );
    expect(restricted.loadedToolNames).toEqual(["Read"]);
  });

  test("direct dispatch and runtime spawn cannot bypass the depth-two limit", async () => {
    // Deliberately retain a registry containing Agent, as a stale caller might.
    await loadSpecificTools(["Agent"]);
    await runWithRuntimeContext(
      { executionSettings: settings(2) },
      async () => {
        for (const name of ["Agent", "Task"]) {
          const result = await executeTool(name, {
            prompt: "must not launch",
            description: "blocked",
            subagent_type: "general-purpose",
          });
          expect(result.status).toBe("error");
          expect(result.toolReturn).toContain("maximum depth 2");
        }
        await expect(
          task({
            prompt: "must not launch",
            description: "blocked",
            subagent_type: "fork",
            conversation_id: "conv-existing",
          }),
        ).rejects.toThrow("maximum depth 2");
        await expect(
          spawnSubagent(
            "general-purpose",
            "must not launch",
            undefined,
            "blocked",
          ),
        ).rejects.toThrow("maximum depth 2");
      },
    );
  });

  test("local and API child environments increment turn-scoped depth for general-purpose and fork", () => {
    for (const backendMode of ["local", "api"] as const) {
      for (const subagentType of ["general-purpose", "fork"]) {
        const child = composeSubagentChildEnv({
          parentProcessEnv: getRuntimeExecutionEnv({}, settings(0)),
          backendMode,
          launchProfile: "default",
          parentAgentId: "root",
          subagentType,
          inheritedPrimaryRoot: null,
        });
        expect(child.LETTA_SUBAGENT_DEPTH).toBe("1");
        const grandchild = composeSubagentChildEnv({
          parentProcessEnv: getRuntimeExecutionEnv(child, settings(1)),
          backendMode,
          launchProfile: "default",
          parentAgentId: "child",
          subagentType,
          inheritedPrimaryRoot: null,
        });
        expect(grandchild.LETTA_SUBAGENT_DEPTH).toBe("2");
        expect(grandchild.LETTA_PARENT_AGENT_ID).toBe("child");
      }
    }
  });
});
