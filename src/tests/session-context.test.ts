import { describe, expect, test } from "bun:test";
import { getMemoryFilesystemRoot } from "../agent/memoryFilesystem";
import { buildSessionContext } from "../cli/helpers/sessionContext";

describe("session context reminder", () => {
  test("includes AGENT_ID and MEMORY_DIR environment values", () => {
    const agentId = "agent-test-session-context";
    const context = buildSessionContext({
      agentInfo: {
        id: agentId,
        name: "Test Agent",
        description: "Test description",
        lastRunAt: null,
      },
      serverUrl: "https://api.letta.com",
    });

    expect(context).toContain(`- **Agent ID**: ${agentId}`);
    expect(context).toContain(`- **AGENT_ID env var**: \`${agentId}\``);
    expect(context).toContain(
      `- **MEMORY_DIR env var**: \`${getMemoryFilesystemRoot(agentId)}\``,
    );
  });
});
