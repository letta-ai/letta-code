import { describe, expect, test } from "bun:test";

// Keep module mocks in a subprocess so they cannot leak into other tests.
describe("listener MemFS repair", () => {
  test("skips untagged subagents while repairing ordinary agents and syncing enabled subagents", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { expect, mock } from "bun:test";
      import { GIT_MEMORY_ENABLED_TAG, LETTA_CODE_SUBAGENT_TAG } from "@/agent/agent-tags";
      const apply = mock(async () => ({}));
      mock.module("@/settings-manager", () => ({ settingsManager: {
        isMemfsExplicitlyDisabled: () => false,
      }}));
      mock.module("@/backend", () => ({ getBackend: () => ({
        retrieveAgent: async (id) => ({ tags: id === "ordinary" ? [] :
          id === "enabled" ? [LETTA_CODE_SUBAGENT_TAG, GIT_MEMORY_ENABLED_TAG] :
          [LETTA_CODE_SUBAGENT_TAG] }),
      }) }));
      mock.module("@/agent/memory-filesystem", () => ({
        applyMemfsFlags: apply, isLettaCloud: async () => true,
      }));
      const { ensureMemfsSyncedForAgent } = await import("@/websocket/listener/memfs-sync");
      const listener = { memfsSyncedAgents: new Map() };
      expect(await ensureMemfsSyncedForAgent(listener, "subagent")).toBe(true);
      expect(apply).not.toHaveBeenCalled();
      expect(await ensureMemfsSyncedForAgent(listener, "ordinary")).toBe(true);
      expect(apply).toHaveBeenLastCalledWith("ordinary", true, {
        pullOnExistingRepo: true, agentTags: [],
      });
      expect(await ensureMemfsSyncedForAgent(listener, "enabled")).toBe(true);
      expect(apply).toHaveBeenLastCalledWith("enabled", undefined, {
        pullOnExistingRepo: true,
        agentTags: [LETTA_CODE_SUBAGENT_TAG, GIT_MEMORY_ENABLED_TAG],
        skipPromptUpdate: true,
      });
    `,
      ],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
  });
});
