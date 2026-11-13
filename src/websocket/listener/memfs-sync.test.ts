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
  const checkout = spyOn(
    memoryFilesystem,
    "ensureLocalMemfsCheckout",
  ).mockResolvedValue();
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
      pullOnExistingRepo: false,
      agentTags: [],
    });
  } finally {
    retrieve.mockRestore();
    disabled.mockRestore();
    cloud.mockRestore();
    apply.mockRestore();
    checkout.mockRestore();
  }
});

test("a refused clone stays unavailable and never repairs the agent", async () => {
  const retrieve = spyOn(getBackend(), "retrieveAgent").mockResolvedValue({
    id: "refused-clone",
    tags: [],
  } as unknown as AgentState);
  const disabled = spyOn(
    settingsManager,
    "isMemfsExplicitlyDisabled",
  ).mockReturnValue(false);
  const cloud = spyOn(memoryFilesystem, "isLettaCloud").mockResolvedValue(true);
  const checkout = spyOn(
    memoryFilesystem,
    "ensureLocalMemfsCheckout",
  ).mockRejectedValue(
    new Error("fatal: The requested URL returned error: 403"),
  );
  const apply = spyOn(memoryFilesystem, "applyMemfsFlags");
  const listener = { memfsSyncedAgents: new Map() } as ListenerRuntime;
  try {
    expect(await ensureMemfsSyncedForAgent(listener, "refused-clone")).toBe(
      false,
    );
    expect(await ensureMemfsSyncedForAgent(listener, "refused-clone")).toBe(
      false,
    );
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    const { isActiveMemfsEnabled, getActiveMemoryDirectory } = await import(
      "@/agent/memory-runtime"
    );
    expect(isActiveMemfsEnabled("refused-clone")).toBe(false);
    expect(getActiveMemoryDirectory("refused-clone")).toBeUndefined();
  } finally {
    retrieve.mockRestore();
    disabled.mockRestore();
    cloud.mockRestore();
    checkout.mockRestore();
    apply.mockRestore();
  }
});
