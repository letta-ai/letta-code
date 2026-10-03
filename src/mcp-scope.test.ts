import { expect, test } from "bun:test";
import { getMcpScopeAgentId } from "./mcp-scope";
import { runWithRuntimeContext } from "./runtime-context";

const parents: Record<string, string> = { worker: "parent", parent: "root" };
const lookup = async (id: string) => parents[id];
const workerEnv = {
  LETTA_CODE_AGENT_ROLE: "subagent",
  LETTA_PARENT_AGENT_ID: "parent",
};

test("MCP inheritance follows nested parents and preserves unrelated deployments", async () => {
  expect(await getMcpScopeAgentId("worker", workerEnv, lookup)).toBe("root");
  expect(await getMcpScopeAgentId("existing", workerEnv, lookup)).toBe(
    "existing",
  );
  expect(await getMcpScopeAgentId("worker", {}, lookup)).toBe("worker");
});

test("listener parent linkage is isolated for each turn", async () => {
  await Promise.all(
    ["worker", "existing"].map((agentId) =>
      runWithRuntimeContext(
        {
          executionSettings: {
            allowed_tools: [],
            disallowed_tools: [],
            disable_memory_guard: false,
            parent_agent_id: "parent",
            agent_role: "subagent",
          },
        },
        async () => {
          await Promise.resolve();
          expect(await getMcpScopeAgentId(agentId, undefined, lookup)).toBe(
            agentId === "worker" ? "root" : "existing",
          );
        },
      ),
    ),
  );
});

test("cyclic or inaccessible parent linkage fails rather than selecting another scope", async () => {
  await expect(
    getMcpScopeAgentId("worker", workerEnv, async () => "worker"),
  ).rejects.toThrow("parent cycle");
  await expect(
    getMcpScopeAgentId("worker", workerEnv, async () => {
      throw new Error("not authorized");
    }),
  ).rejects.toThrow("not authorized");
});
