import { describe, expect, test } from "bun:test";
import type { SubagentConfig } from "@/agent/subagents";
import { buildSubagentArgs } from "@/agent/subagents/manager";
import { resolveSubagentHarnessTools } from "@/agent/subagents/subagent-depth";
import { composeSubagentChildEnv } from "@/agent/subagents/subagent-launcher";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  getRuntimeExecutionEnv,
  subagentExecutionSettings,
} from "@/runtime-execution-settings";
import { SUBAGENT_DEPTH_ENV } from "@/utils/subagent-depth-env";

const generalPurpose: SubagentConfig = {
  name: "general-purpose",
  description: "",
  systemPrompt: "",
  allowedTools: ["Bash", "Read"],
  recommendedModel: "inherit",
  skills: [],
  fork: false,
  launchProfile: "default",
};

function launchChild(parentProcessEnv: NodeJS.ProcessEnv) {
  return composeSubagentChildEnv({
    parentProcessEnv,
    parentAgentId: "agent-parent",
    parentConversationId: "conv-parent",
    launchProfile: "default",
    inheritedPrimaryRoot: null,
  });
}

function scopedToolsFlag(parentDepth: number): string[] {
  const args = runWithRuntimeContext(
    {
      executionSettings: {
        allowed_tools: [],
        disallowed_tools: [],
        disable_memory_guard: false,
        ...(parentDepth > 0
          ? { agent_role: "subagent", subagent_depth: parentDepth }
          : {}),
      },
    },
    () =>
      buildSubagentArgs(
        "general-purpose",
        generalPurpose,
        null,
        "work",
        undefined,
        undefined,
        undefined,
        {
          extraTools: resolveSubagentHarnessTools(
            "general-purpose",
            generalPurpose,
          ),
        },
      ),
  );
  return args[args.indexOf("--tools") + 1]?.split(",") ?? [];
}

describe("subagent depth", () => {
  test("each launch is one level below its launcher, including listener-hosted turns", () => {
    const child = launchChild({ PATH: "/bin" });
    expect(child[SUBAGENT_DEPTH_ENV]).toBe("1");
    expect(launchChild(child)[SUBAGENT_DEPTH_ENV]).toBe("2");

    // A depth-1 child whose turn runs on a listener forwards its identity in
    // execution settings; the listener process itself has no depth.
    const settings = {
      allowed_tools: [],
      disallowed_tools: [],
      disable_memory_guard: false,
      ...subagentExecutionSettings(child),
    };
    expect(settings).toMatchObject({
      subagent_depth: 1,
      parent_conversation_id: "conv-parent",
    });
    const listenerTurnEnv = getRuntimeExecutionEnv(
      { PATH: "/bin", [SUBAGENT_DEPTH_ENV]: "7" },
      settings,
    );
    expect(launchChild(listenerTurnEnv)[SUBAGENT_DEPTH_ENV]).toBe("2");
  });

  test("a turn without a per-turn depth keeps its process depth (SDK Workflow app servers)", () => {
    const workerTurnEnv = getRuntimeExecutionEnv(
      { PATH: "/bin", [SUBAGENT_DEPTH_ENV]: "2" },
      { allowed_tools: [], disallowed_tools: [], disable_memory_guard: true },
    );
    expect(workerTurnEnv[SUBAGENT_DEPTH_ENV]).toBe("2");
    expect(launchChild(workerTurnEnv)[SUBAGENT_DEPTH_ENV]).toBe("3");
  });

  test("general-purpose children get Agent only above the leaf depth, and SendAgentMessage always", () => {
    expect(scopedToolsFlag(0)).toEqual(
      expect.arrayContaining(["Bash", "Read", "SendAgentMessage", "Agent"]),
    );
    const leaf = scopedToolsFlag(1);
    expect(leaf).toEqual(
      expect.arrayContaining(["Bash", "Read", "SendAgentMessage"]),
    );
    expect(leaf).not.toContain("Agent");
  });

  test("restricted and memory workers do not gain Agent", () => {
    const recall = { ...generalPurpose, allowedTools: ["Bash", "Read"] };
    expect(resolveSubagentHarnessTools("recall", recall, 1)).toEqual([
      "SendAgentMessage",
    ]);
    expect(
      resolveSubagentHarnessTools(
        "reflection",
        { ...recall, launchProfile: "memory-subagent" },
        1,
      ),
    ).toEqual([]);
  });
});
