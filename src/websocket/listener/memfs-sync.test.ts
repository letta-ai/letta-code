import { expect, spyOn, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import * as memoryFilesystem from "@/agent/memory-filesystem";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { ensureMemfsSyncedForAgent } from "./memfs-sync";
import type { ListenerRuntime } from "./types";

test("skips subagent repair while repairing an ordinary agent on Letta Cloud", async () => {
  const retrieve = spyOn(getBackend(), "retrieveAgent").mockResolvedValue({
    id: "subagent",
    tags: ["role:subagent"],
  } as AgentState);
  const disabled = spyOn(
    settingsManager,
    "isMemfsExplicitlyDisabled",
  ).mockReturnValue(false);
  const cloud = spyOn(memoryFilesystem, "isLettaCloud").mockResolvedValue(true);
  const apply = spyOn(memoryFilesystem, "applyMemfsFlags").mockResolvedValue({
    action: "unchanged",
  });
  const listener = { memfsSyncedAgents: new Map() } as ListenerRuntime;
  try {
    expect(await ensureMemfsSyncedForAgent(listener, "subagent")).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    retrieve.mockResolvedValue({
      id: "ordinary",
      tags: [],
    } as unknown as AgentState);
    expect(await ensureMemfsSyncedForAgent(listener, "ordinary")).toBe(true);
    expect(apply).toHaveBeenCalledWith("ordinary", true, {
      pullOnExistingRepo: true,
      agentTags: [],
    });
  } finally {
    retrieve.mockRestore();
    disabled.mockRestore();
    cloud.mockRestore();
    apply.mockRestore();
  }
});
