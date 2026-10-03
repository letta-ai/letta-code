import { expect, test } from "bun:test";
import { getMcpScopeAgentId } from "./mcp-scope";
import { runWithRuntimeContext } from "./runtime-context";
import { getRuntimeExecutionEnv } from "./runtime-execution-settings";

test("MCP scope follows the parent without changing worker identity", () => {
  const env = { LETTA_AGENT_ID: "worker", LETTA_MCP_AGENT_ID: "parent" };
  expect(getMcpScopeAgentId("worker", env)).toBe("parent");
  expect(env.LETTA_AGENT_ID).toBe("worker");
  expect(getMcpScopeAgentId("existing", {})).toBe("existing");
});

test("listener MCP scope is isolated from ambient and other turn scopes", async () => {
  await Promise.all(
    ["parent-a", "parent-b", undefined].map((mcpAgentId) =>
      runWithRuntimeContext(
        {
          executionSettings: {
            allowed_tools: [],
            disallowed_tools: [],
            disable_memory_guard: false,
            mcp_agent_id: mcpAgentId,
          },
        },
        async () => {
          await Promise.resolve();
          expect(getMcpScopeAgentId("worker")).toBe(mcpAgentId ?? "worker");
          const env = getRuntimeExecutionEnv(
            { LETTA_MCP_AGENT_ID: "stale" },
            {
              allowed_tools: [],
              disallowed_tools: [],
              disable_memory_guard: false,
              mcp_agent_id: mcpAgentId,
            },
          );
          expect(env.LETTA_MCP_AGENT_ID).toBe(mcpAgentId);
        },
      ),
    ),
  );
});
