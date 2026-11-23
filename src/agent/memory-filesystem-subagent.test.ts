import { expect, spyOn, test } from "bun:test";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { applyMemfsFlags } from "@/agent/memory-filesystem";
import * as modify from "@/agent/modify";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";

test("does not enable remote MemFS for an untagged subagent", async () => {
  const backend = getBackend();
  const retrieve = spyOn(backend, "retrieveAgent").mockResolvedValue({
    id: "subagent",
    tags: ["origin:letta-code", "role:subagent"],
  } as AgentState);
  const update = spyOn(backend, "updateAgent");
  const settings = spyOn(settingsManager, "setMemfsEnabled").mockImplementation(
    () => {},
  );
  const enabled = spyOn(settingsManager, "isMemfsEnabled").mockReturnValue(
    false,
  );
  const prompt = spyOn(
    modify,
    "updateAgentSystemPromptMemfs",
  ).mockResolvedValue({
    success: false,
    message: "Unexpected prompt update",
  });
  try {
    expect(backend.capabilities.remoteMemfs).toBe(true);
    const result = await applyMemfsFlags("subagent", true, {
      agentTags: ["origin:letta-code", "role:subagent"],
    }).catch((error: unknown) => error);
    expect(prompt).not.toHaveBeenCalled();
    expect(result).toEqual({ action: "unchanged" });
    expect(retrieve).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  } finally {
    retrieve.mockRestore();
    update.mockRestore();
    settings.mockRestore();
    enabled.mockRestore();
    prompt.mockRestore();
  }
});
