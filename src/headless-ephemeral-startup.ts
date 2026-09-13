import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  createEphemeralConversation,
  createLocalEphemeralConversation,
} from "@/agent/ephemeral-conversation";
import {
  configureEphemeralLocalBackend,
  isLocalBackendEnabled,
} from "@/backend";
import { clearPersistedClientToolRules } from "@/tools/toolset";
import { debugLog, debugWarn } from "@/utils/debug";

export function prepareHeadlessEphemeralBackend(enabled: boolean): void {
  if (enabled && isLocalBackendEnabled()) {
    configureEphemeralLocalBackend();
  }
}

export async function createHeadlessEphemeralConversation(params: {
  backendMode: string;
  personality: string | null | undefined;
  model: string | undefined;
  systemPromptPreset: string | undefined;
  systemPromptCustom: string | undefined;
}): Promise<{ agent: AgentState; conversationId: string }> {
  if (params.personality) {
    throw new Error(
      "--ephemeral cannot be used with --personality because it has no memory blocks",
    );
  }
  const options = {
    model: params.model,
    systemPromptPreset: params.systemPromptPreset,
    systemPromptCustom: params.systemPromptCustom,
    memoryPromptMode: "standard" as const,
  };
  return params.backendMode === "local"
    ? createLocalEphemeralConversation(options)
    : createEphemeralConversation(options);
}

export function clearHeadlessClientToolRules(agent: AgentState): void {
  void clearPersistedClientToolRules(agent.id, agent)
    .then((cleanup) => {
      if (cleanup) {
        const count = cleanup.removedToolNames.length;
        const names = cleanup.removedToolNames.join(", ");
        debugLog(
          "headless startup",
          `Cleared ${count} persisted client tool rule${count === 1 ? "" : "s"} for ${agent.id}${count > 0 ? `: ${names}` : ""}`,
        );
        return;
      }
      debugLog(
        "headless startup",
        `No persisted client tool rules to clear for ${agent.id}`,
      );
    })
    .catch((error) => {
      debugWarn(
        "headless startup",
        `Failed to clear persisted client tool rules for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}
