import { afterEach, describe, expect, test } from "bun:test";
import { getCurrentSubagentDepth } from "@/agent/subagents/subagent-depth";
import { runWithRuntimeContext } from "@/runtime-context";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { prepareToolExecutionContextForResolvedTarget } from "@/tools/toolset";
import { SUBAGENT_DEPTH_ENV } from "@/utils/subagent-depth-env";
import { createSdkSpawner } from "./sdk-spawner.ts";
import type { SdkClient, SdkQuery } from "./types.ts";

const originalDepth = process.env[SUBAGENT_DEPTH_ENV];

afterEach(() => {
  if (originalDepth === undefined) delete process.env[SUBAGENT_DEPTH_ENV];
  else process.env[SUBAGENT_DEPTH_ENV] = originalDepth;
  clearCapturedToolExecutionContexts();
});

function recordingClient(): SdkClient & {
  options: Array<Record<string, unknown>>;
} {
  const options: Array<Record<string, unknown>> = [];
  const query: SdkQuery = {
    conversationId: "conv-worker",
    agentId: null,
    async *[Symbol.asyncIterator]() {
      yield { type: "result", success: true, result: "done" };
    },
    async interrupt() {},
    close() {},
  };
  return {
    options,
    query(params) {
      options.push(params.options);
      return query;
    },
  };
}

/** Tools a worker turn sees inside its app server: SDK settings carry no depth. */
async function workerTools(appServerEnv: Record<string, string>) {
  Object.assign(process.env, appServerEnv);
  const prepared = await prepareToolExecutionContextForResolvedTarget({
    modelIdentifier: "anthropic/claude-sonnet-4-6",
    toolsetPreference: "default",
    clientToolAllowlist: ["Read", "Agent", "Workflow"],
    runtimeContext: {
      executionSettings: {
        allowed_tools: [],
        disallowed_tools: [],
        disable_memory_guard: true,
      },
    },
  });
  return prepared.preparedToolContext.loadedToolNames;
}

describe("Workflow worker depth", () => {
  test("a worker launched from depth N runs at N+1 and loses Agent and Workflow at the max depth", async () => {
    for (const parentDepth of [0, 1]) {
      const client = recordingClient();
      const workerDepth = runWithRuntimeContext(
        {
          executionSettings: {
            allowed_tools: [],
            disallowed_tools: [],
            disable_memory_guard: false,
            ...(parentDepth > 0
              ? { agent_role: "subagent" as const, subagent_depth: parentDepth }
              : {}),
          },
        },
        () => getCurrentSubagentDepth() + 1,
      );
      await createSdkSpawner(client, {
        parentAgentId: "agent-parent",
        model: "openai/gpt-5.6-luna",
        workerDepth,
      })(
        { prompt: "inspect", options: {}, callIndex: 0 },
        new AbortController().signal,
      );
      const env = client.options[0]?.env as Record<string, string>;
      expect(env[SUBAGENT_DEPTH_ENV]).toBe(String(parentDepth + 1));

      const tools = await workerTools(env);
      if (parentDepth + 1 >= 2) {
        expect(tools).toContain("Read");
        expect(tools).not.toContain("Agent");
        expect(tools).not.toContain("Workflow");
      } else {
        expect(tools).toEqual(
          expect.arrayContaining(["Read", "Agent", "Workflow"]),
        );
      }
    }
  });
});
