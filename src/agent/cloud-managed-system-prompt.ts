import type { AgentState } from "@letta-ai/letta-client/resources/agents";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import type { MemoryPromptMode } from "./prompt-assets";
import {
  CLOUD_MANAGED_PROMPT_PRESET,
  decideManagedSystemPromptUpdate,
  isCloudPromptBackend,
} from "./system-prompt-versioning";

/** Keep a memory-mode change from re-pinning a Cloud-owned default prompt. */
export async function reconcileCloudPromptForMemoryMode(input: {
  agent: AgentState;
  memoryMode: MemoryPromptMode;
  storedPreset?: string;
  storedHash?: string;
}): Promise<string | undefined> {
  const { agent, memoryMode, storedPreset, storedHash } = input;
  const backend = getBackend();
  if (storedPreset === CLOUD_MANAGED_PROMPT_PRESET) {
    if (agent.system == null) {
      return "Cloud-managed system prompt left unchanged for memory mode";
    }
    if (settingsManager.isReady)
      settingsManager.setSystemPromptCustom(agent.id);
    return "Custom system prompt left unchanged for memory mode";
  }
  if (
    backend.capabilities.environmentRouting &&
    process.env.LETTA_CODE_PRESERVE_CLOUD_SYSTEM_PROMPT === "1"
  ) {
    return "Cloud system prompt preservation requested";
  }
  if (backend.capabilities.remoteMemfs && agent.system == null) {
    return "Cloud-managed system prompt left unchanged for memory mode";
  }
  if (!isCloudPromptBackend()) {
    return undefined;
  }

  // Startup may be migrating this old default concurrently. Apply the same
  // exact-match decision rather than racing it by writing the old text back.
  const decision = decideManagedSystemPromptUpdate({
    agent,
    memoryMode,
    isLettaCloud: true,
    storedPreset,
    storedHash,
    storedVersion: settingsManager.isReady
      ? settingsManager.getSystemPromptVersion(agent.id)
      : undefined,
  });
  if (decision.kind !== "inherit") return undefined;

  const updatedAgent = await backend.updateAgent(agent.id, { system: null });
  if (updatedAgent.system !== null) {
    const persistedAgent = await backend.retrieveAgent(agent.id);
    if (persistedAgent.system !== null) {
      throw new Error("Cloud did not clear the stored system prompt");
    }
  }
  if (settingsManager.isReady) {
    settingsManager.setSystemPromptPreset(
      agent.id,
      CLOUD_MANAGED_PROMPT_PRESET,
    );
  }
  return "Cloud now owns the default system prompt";
}
