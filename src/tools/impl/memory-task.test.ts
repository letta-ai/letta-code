import { expect, test } from "bun:test";
import { ensureMemoryRepair } from "./memory-task-lifecycle";
import { launchSubagent, type SpawnBackgroundSubagentTaskArgs } from "./task";

test.each(["memory", "memory-repair"])(
  "%s cannot be dispatched through the public launch entry point",
  async (subagent_type) => {
    const result = await launchSubagent({
      subagent_type,
      prompt: "Edit memory",
      description: "Edit memory",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("harness-only");
  },
);

test.each(["conflict", "invalid"] as const)(
  "the harness launches %s repair with its original claim and scope",
  async (status) => {
    let spawned: SpawnBackgroundSubagentTaskArgs | undefined;
    const launched = await ensureMemoryRepair(
      {
        agentId: "agent-parent",
        conversationId: "conv-parent",
        result: {
          status,
          memoryDir: "/memory",
          summary: status,
          localOnly: true,
        },
      },
      (args) => {
        spawned = args;
      },
      async () => ({ status: "claimed", token: "claim-token" }),
    );
    expect(launched).toBe(true);
    expect(spawned?.subagentType).toBe("memory-repair");
    expect(spawned?.memoryRepairToken).toBe("claim-token");
    expect(spawned?.parentScope).toEqual({
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
    expect(spawned?.memoryScope).toEqual({
      primaryRoot: "/memory",
      writableRoots: ["/memory"],
    });
    expect(spawned?.prompt).toContain(
      status === "invalid"
        ? "move detail"
        : "Repair only the existing Git conflict",
    );
  },
);
